#!/usr/bin/env node

// ========================================================================
// Copyright 2014 Microsoft Corporation

// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at

//     http://www.apache.org/licenses/LICENSE-2.0

// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========================================================================

var express = require('express');
var app = express();
var http = require('http');
var https = require('https');
var httpServer = http.Server(app);
var io = require('socket.io')(httpServer);
var fs = require('fs');
var spawn = require('child_process').spawn;
var path = require("flavored-path");
var cli = require("cli").enable('status');

var queuedConnection = require('./QueuedConnection.js');
var portmanager = require("./PortManager.js");

var appOptions = {
	'KubernetesServer': ['s', 'URL of the Kubernetes Server', 'url'],
	'NumMinions': ['m', 'Number of minions in Kubernetes cluster', 'number'],

	'PodRefreshInterval': ['p', 'Time between requesting the list of pods from the master (in milliseconds)', 'number', 3000],
	'OperationRefreshInterval': ['o', 'Time between checking the status on pending operations (in milliseconds)', 'number', 1000],

	'KubePath': ['k', 'Kubernetes repo path', 'path', '../kubernetes'],
	'KubeAuthPath': ['a', 'Path to the kubernetes authorization file', 'path', '~/.kubernetes_auth'],
	'KubeApiVersion': ['v', 'Version of the Kubernetes api to query against', 'string', 'v1beta1'],
	'ListenPort': ['p', 'The port the server should listen on', 'number', 3000],
	'MaxReplicas': ['r', 'The maximum number of replicas the server will allow a client to create at once', 'number', 300],
	'DefaultImage': ['i', 'The default docker image to use when creating pods', 'string', 'dockerfile/nginx'],
};

var options = process.clioptions = cli.parse(appOptions);

var environmentVariables = [ "AZ_CS", "KUBERNETES_PATH", "NUM_MINIONS" ];
for (var option in appOptions) {
	var type = typeof appOptions[option][2] !== 'undefined' ? appOptions[option][2] : 'string';
	if (type !== 'number' && type !== 'bool') {
		type = 'string';
	}

	var required = typeof appOptions[option][3] === 'undefined';

	if (required && typeof options[option] !== type) {
		cli.error("Required \"" + option + "\" parameter not set. Use the -h or --help args to see help information.");
		cli.getUsage();
		process.exit(1);
	}
}

var listenPort = options.ListenPort;

var sockets = [];
var pods = [];

var createMode = 'pods';
var MaxReplicas = options.MaxReplicas;
var KnownImages = [
	'dockerfile/nginx',
	'brendanburns/redis-slave',
	'dockerfile/redis',
];

if (typeof options.DefaultImage !== 'undefined' && KnownImages[0] != options.DefaultImage) {
	if (KnownImages.indexOf(options.DefaultImage) !== -1) {
		delete KnownImages[KnownImages.indexOf(options.DefaultImage)];
	}

	KnownImages.splice(0, 0, options.DefaultImage);
}

var activeOperations = {
	// "id": {}
};

var podRefreshInterval = options.PodRefreshInterval;
var operationRefreshInterval = options.operationRefreshInterval;

// Load kubernetes auth info
var kubernetes_auth_file = path.get("~/.kubernetes_auth");
if (!fs.existsSync(kubernetes_auth_file)) {
	cli.fatal("Error: Could not find kubrenetes auth file: " + kubernetes_auth_file);
}

var kubernetesAuth = JSON.parse(fs.readFileSync(kubernetes_auth_file).toString());
var kubeServer = options.KubernetesServer;
var kubeApiVersion = options.KubeApiVersion;
var kubeAllowedApiVersions = [ "v1beta1", "v1beta2" ];

if (kubeAllowedApiVersions.indexOf(kubeApiVersion) === -1) {
	kubeAllowedApiVersions.push(kubeApiVersion);
}

var PortManager = new portmanager.PortManager(options.NumMinions);
var QueuedConnectionManager = new queuedConnection.QueuedConnectionManager({
	'host': kubeServer,
	'apiVersion': kubeApiVersion,
	'user': kubernetesAuth['User'],
	'password': kubernetesAuth['Password'],
});

cli.info("Using kubernetes server: " + kubeServer);
cli.info("Using kubernetes default API version: " + kubeApiVersion);
cli.info("Using " + options.DefaultImage + " as the default image when creating pods");
cli.info("Expected number of kubernetes minions: " + options.NumMinions);
console.log();

// Setup tasks that need to occur on an interval
queryRunningPods();
cli.debug("Querying running pods every " + options.PodRefreshInterval + " milliseconds");
setInterval(function(){
	queryRunningPods();
}, options.PodRefreshInterval);

cli.debug("Querying running operations every " + options.OperationRefreshInterval + " milliseconds");
setInterval(function(){
	CheckActiveOperationStatuses();
}, operationRefreshInterval);

io.on('connection', function(socket){
	cli.debug('a user connected');
	sockets.push(socket);
	
	socket.on('create_replicated_pod', function(startParameters) {
		cli.info("Creating containers with name " + startParameters.Name + ", number of contaiers: " + startParameters.Replicas + ", id: " + startParameters.Labels.Id);

		var createRequest = new PodCreateRequest(startParameters);

		if (createRequest === null) {
			cli.error("Error: Invalid input for PodCreateRequest");
			return;
		}

		HandlePodCreateRequest(createRequest);
	});

	socket.on('get_pods', function() {
		socket.emit('pods', pods);
	});

	socket.on('delete_all_pods', function() {
		deleteRunningPods();
	});

	socket.on('get_base_config', function(startParameters){
		var createRequest = new PodCreateRequest(startParameters);
		
		if (createRequest == null || typeof createRequest !== 'object' || Object.keys(createRequest).length === 0) {
			cli.error("Error: Invalid input for PodCreateRequest " + JSON.stringify(startParameters) + " " +  JSON.stringify(createRequest));
			return;
		}

		socket.emit(
			'set_base_config', 
			{ 
				'pods': GetPodConfigObject(createRequest, 1337, 'pods'), 
				'replicas': GetPodConfigObject(createRequest, 1337, 'replicas') 
			});
	});

	socket.on('disconnect', function () {
		cli.debug("User disconnected");
		var index = sockets.indexOf(socket);
		delete sockets[index];
	});
});

app.use('/', express.static(__dirname + '/client'));

httpServer.listen(listenPort, function(){
	cli.info('K8s Visualizer server listening on *:' + listenPort);
});

function queryRunningPods() {
	var requestOptions = QueuedConnectionManager.GetRequestOptionsForApi("pods", "GET");

	requestOptions['connectionPriority'] = 'immediate';

	var resultHandler = function(error, result) {
		if (error !== null || typeof result !== 'object') {
			cli.error("Error querying running pods: " + " " + error + " " + result);
			return;
		}

		parseListQueryOutput(result);
	}

	QueuedConnectionManager.GetJSONQueryResultConnection(requestOptions, resultHandler);
}

function deleteRunningPods() {
	cli.debug('Deleting all pods');
	for (var p in pods) {
		deletePod(pods[p].BaseObject.id);
	}
}

function deletePod(id) {
	var requestOptions = QueuedConnectionManager.GetRequestOptionsForApi("pods/" + id, "DELETE");

	var resultHandler = function(error, result) {
		if (error !== null || typeof result !== 'object') {
			cli.error("Error deleting running pods: " + " " + error + " " + result);
			return;
		}

		cli.ok("Pod delete complete");
		for (var p in pods) {
			if (pods[p].Id === id) {
				delete pods[p];
				break;
			}
		}

		PushPodsToSockets(pods, sockets);
	}

	QueuedConnectionManager.GetJSONQueryResultConnection(requestOptions, resultHandler);
}

function parseListQueryOutput(response) {
	switch (response.kind) {
		case "PodList":
			parsePodList(response.items);
			break;
		default:
			cli.error("Unknown list type received from query: " + response.kind);
	}
}

function parsePodList(raw_pods) {
	var new_pods = [];
	usedPorts = [];

	PortManager.Reset();

	for (var p in raw_pods) {
		var pod = raw_pods[p];

		var images = [];
		for (var c in pod.desiredState.manifest.containers) {
			var container = pod.desiredState.manifest.containers[c];
			images.push(container.image);

			for (p in container.ports) {
				PortManager.AddUsedPort(parseInt(container.ports[p].hostPort))
			}
		}

		if (pod.id in activeOperations) {
			var loaded = true;
			try {
				if (typeof pod.currentState === 'undefined' || typeof pod.currentState.info === 'undefined') {
					loaded = false;
				} else {
					for (var c in pod.desiredState.manifest.containers) {
						loaded &= pod.desiredState.manifest.containers[c].name in pod.currentState.info;
						if (!loaded) break;
					}
				}
			} catch (exc) {
				cli.debug("podcheck error");
				loaded = false;
			}

			if (loaded) {
				cli.debug("Marking pod complete");
				delete activeOperations[pod.id];
			}
		}

		new_pods.push( 
			new Pod(
				pod.id, 
				images, 
				pod.currentState.host, 
				pod.labels,
				pod));
	}

	cli.info("" + new_pods.length + " Pods found");

	pods = new_pods;

	PushPodsToSockets(new_pods, sockets);

	if (pods.length === 0) {
		cli.debug("Reset port PortManager")
		PortManager.Reset();
	}
}

var allowOperationStatusChecks = true;
var activeOperationQueries = {};
function CheckActiveOperationStatuses() {
	if (!allowOperationStatusChecks) return;
	for (var o in activeOperations) {
		(function (id, operationNo) {
			if (id in activeOperationQueries) {
				return;
			}

			var requestOptions = QueuedConnectionManager.GetRequestOptionsForApi("operations/" + operationNo, "GET");
			activeOperationQueries[id] = true;
			var resultHandler = function(error, result) {
				if (error !== null || typeof result !== 'object') {
					cli.error("Error querying operation status: " + error + " " + result);

					if (id in activeOperations) {
						delete activeOperations[id];
					}

					return;
				}

				if (id in activeOperationQueries) {
					delete	activeOperationQueries[id];
				}

				ParseOperationStatus(id, result);
			}

			QueuedConnectionManager.GetJSONQueryResultConnection(requestOptions, resultHandler);
		})(o, activeOperations[o].details);
	}
}

function ParseOperationStatus(id, status) {
	if (typeof status.kind !== 'undefined' && status.kind === "Status") {
		activeOperations[id] = status;
	} else if (id in activeOperations) {
		cli.ok("Operation complete for item: " + id);

		delete activeOperations[id];

		for (var p in pods) {
			if (pods[p].BaseObject.desiredState.manifest.id == id) {
				pods[p].CreateStatus = false;
				PushPodsToSockets(pods, sockets);
				break;
			}
		}
	}
};

function ParsePodListOutput(output) {
	var lines = output.split("\n");
	var new_pods = [];

	// Iterate from the third line to the end
	for (var i = 2; i < lines.length; i++) {
		try {
			var trimmed = lines[i].trim();

			if (trimmed == "") continue;

			var cols = lines[i].split(/\s+/g);
			var Name = cols[0];
			var Images = cols[1].split(',');
			var Host = cols[2];
			var Labels = cols[3].split(',');

			var labels_obj = {};
			for (var j = 0; j < Labels.length; j++) {
				var label_split = Labels[j].split('=');
				labels_obj[label_split[0]] = label_split[1];
			}

			new_pods.push(new Pod(Name, Images, Host, labels_obj));
		} catch (exc) {

		}
	}

	if (new_pods.length !== 0) {
		pods = new_pods;
	}
}

function PushPodsToSockets(pods, sockets) {
	for (var s in sockets) {
		sockets[s].emit('pods', pods);
	}
}

function HandlePodCreateRequest(podCreateRequest) {
	cli.debug("Create mode is " +  createMode);

	switch (createMode) {
		case 'replicas':
			CreateReplicatedPod(podCreateRequest);
			break;

		case 'pods':
			CreateIndividualPodsFromReplicatedPodRequest(podCreateRequest);
			break;

		default:
			cli.error("Error: unknown create mode: " + createMode)
	}
}

function GetPodConfigObject(podCreateRequest, hostPort, mode, i) {
	var useI = typeof i != 'undefined';
	var id = podCreateRequest.Labels['Id'] + (useI ? '-' + i : '');
	var nameSlug = podCreateRequest.Name.replace(/[^a-zA-Z0-9]+/g, '').toLowerCase();

	switch (typeof mode === 'string' ? mode : createMode) {
		case 'replicas':
			return {
				"id": id,
				"kind": "ReplicationController",
				"apiVersion": "v1beta2",
				"desiredState": {
					"replicas": podCreateRequest.Replicas,
					"replicaSelector": podCreateRequest.Labels,
					"podTemplate": {
						"desiredState": {
							"manifest": {
								"version": 'v1beta2',
								"id": id,
								"volumes": [],
								"containers": [{
									"name": nameSlug,
									"image": podCreateRequest.Image,
									"ports": [{"containerPort": 80, "hostPort": hostPort, 'protocol': 'TCP'}]
								}]
							},
							'restartPolicy': {},
						},
						"labels": podCreateRequest.Labels
					}},
				"labels": podCreateRequest.Labels
			};
			break;

		case 'pods':
			return {
				"kind": "Pod",
				"id": id,
				"apiVersion": kubeApiVersion,
				"desiredState": {
					"manifest": {
						"id": id,
						"version": kubeApiVersion,
						"containers": [{
							"name": nameSlug + (useI ? i: ''),
							"version": kubeApiVersion,
							"image": podCreateRequest.Image,
							"ports": [{"containerPort": 80, "hostPort": hostPort, 'protocol': 'TCP'}]
						}]
					},
				},
				"labels": podCreateRequest.Labels
			};
			break;

		default:
			return null;
	}
}

function CreateReplicatedPod(podCreateRequest) {
	if (podCreateRequest.Name == "") return;

	cli.debug("Executing podCreateRequest: " + podCreateRequest);

	// Compute a port for this pod
	var hostPort = PortManager.NextPort(podCreateRequest.Replicas);

	if (hostPort == null) {
		// We goofed
		cli.error("Error: Could not get hostPort for podCreateRequest");
		return;
	}

	var podConfig = GetPodConfigObject(podCreateRequest, hostPort, createMode);

	cli.debug("About to create replication controller request for pod: " + JSON.stringify(podConfig));

	var requestOptions = QueuedConnectionManager.GetRequestOptionsForApi("replicationControllers", "POST");

	var resultHandler = function(error, result) {
		if (error !== null || typeof result !== 'object') {
			cli.error("Error creating replication controller: " + error + " " + result);
			return;
		}

		if (typeof result.kind !== 'undefined' && result.kind === "Status") {
			cli.ok("Adding replicationController " + podConfig.id + " to active operations");
			ParseOperationStatus(podConfig.id, result);
		}
	}

	QueuedConnectionManager.GetJSONQueryResultConnection(requestOptions, resultHandler, podConfig);
}

function CreateIndividualPodsFromReplicatedPodRequest(podCreateRequest) {
	if (podCreateRequest.Name == "") return;

	cli.debug("Executing podCreateRequest: " + JSON.stringify(podCreateRequest));
	var id = null;

	for (var i = 0; i < podCreateRequest.Replicas; i++) {
		var isRaw = typeof podCreateRequest.RawRequest != 'undefined' && podCreateRequest.RawRequest != null;

		if (isRaw && !podCreateRequest.ValidateRawRequest(1)) {
			cli.error("podCreateRequest validation failed. Cannot continue creating pod");
			return;
		}

		var hostPort = null;
		var config = null;

		if (isRaw) {
			cli.debug("Creating individual pods from RawRequest");

			// Do this the lazy way
			config = JSON.parse(JSON.stringify(podCreateRequest.RawRequest));

			// edit the id
			if (id == null) {
				id = config.id;
			}

			config.id = id + "-" + i;
			config.desiredState.manifest.id = id + "-" + i;
		} else {
			hostPort = PortManager.NextPort();
			if (hostPort == null) {
				// We goofed
				cli.error("Error: Could not get hostPort for podCreateRequest");
				return;
			}

			cli.debug("Trying port " + hostPort);

			var config = GetPodConfigObject(podCreateRequest, hostPort, createMode, i)

			if (config == null) {
				cli.error("An error occured retrieving the config");
			}
		}

		(function (podConfig) {
			var t = 1;
			cli.debug("About to create pod " + i + ": " + JSON.stringify(podConfig));

			var requestOptions = QueuedConnectionManager.GetRequestOptionsForApi("pods", "POST");

			var resultHandler = function(error, result) {
				if (error !== null || typeof result !== 'object') {
					cli.error("Error querying operation status: " + error + " " + result);
					if (t === 1) {
						// Try once more
						t ++;
						QueuedConnectionManager.GetJSONQueryResultConnection(requestOptions, resultHandler, podConfig);
					}
					return;
				}

				if (typeof result.kind !== 'undefined' && result.kind === "Status") {
					cli.ok("Adding " + podConfig.id + " to active operations");
					ParseOperationStatus(podConfig.id, result);

					var pod = new Pod(podConfig.labels.name, [], '', podConfig.labels, podConfig);
					pod.CreateStatus = result;
					pods.push(pod);
					PushPodsToSockets(pods, sockets);
				}
			}

			QueuedConnectionManager.GetJSONQueryResultConnection(requestOptions, resultHandler, podConfig);
		})(config);
	}
}

//// Define Objects 
function Pod(Name, Images, Host, Labels, BaseObject) {
	return {
		'Name': typeof Name === 'string' ? Name : '',
		'Images': typeof Images === 'object' ? Images : [],
		'Host': typeof Host === 'string' ? Host : '',
		'Labels': typeof Labels === 'object' ? Labels : {},
		'CreateStatus': BaseObject.desiredState.manifest.id in activeOperations ? activeOperations[BaseObject.desiredState.manifest.id] : false,
		'BaseObject': typeof BaseObject === 'object' ? BaseObject : {}
	};
}

var PodCreateRequest = (function(){
	function PodCreateRequest(fromObj) {
		if (typeof fromObj.RawRequest !== 'undefined' && fromObj.RawRequest != null) {
			if (typeof fromObj.RawRequest !== 'object') {
				cli.error("Error: RawRequest is an invalid type: " + typeof fromObj.RawRequest);
				return null;
			}

			this.Name = typeof fromObj.RawRequest.labels.name === 'string' ? fromObj.RawRequest.labels.name : '';
			this.Image = '';
			this.Labels = typeof fromObj.RawRequest.labels === 'object' ? fromObj.RawRequest.labels : {};
			this.RawRequest = fromObj.RawRequest;
		} else {
			this.Name = typeof fromObj.Name === 'string' ? fromObj.Name : '';
			this.Image = typeof fromObj.Image === 'object' ? fromObj.Image : '';
			this.Labels = typeof fromObj.Labels === 'object' ? fromObj.Labels : {};
			this.RawRequest = null;
		}

		this.Replicas = typeof fromObj.Replicas !== 'undefined' ? fromObj.Replicas : 1;

		if (typeof this.Replicas === 'string') {
			this.Replicas = parseInt(this.Replicas);
		}

		if (this.Replicas > MaxReplicas) {
			this.Replicas = MaxReplicas;
		}

		if (typeof this.Labels['name'] !== 'string') {
			this.Labels['name'] = this.Name;
		}

		if (typeof this.Labels['Id'] === 'number') {
			this.Labels['Id'] = "" + this.Labels['Id'];
		}

		if (typeof this.Labels['Id'] !== 'string') {
			cli.error("No id found for podcreaterequest");
			return null;
		}

		if (this.Name.length === 0) {
			return null;
		}

		if (KnownImages.indexOf(this.Image) === -1) {
			cli.info("Unkown image " + this.Image + ". using default: " + KnownImages[0]);
			this.Image = KnownImages[0];
		}
	}

	function validateField(obj, field, type, allowed, defaultValue, message) {
		if (!!defaultValue && typeof obj[field] === 'undefined') {
			obj[field] = defaultValue;
		} else if (typeof obj[field] === 'undefined') {
			cli.error("Field is undefined");
			cli.error(message + obj[field]);
			return false;
		}

		if (typeof obj[field] !== type) {
			cli.error("Field type does not match: " + typeof obj[field]);
			cli.error(message + obj[field]);
			return false;
		}

		if (!!allowed && allowed.indexOf(obj[field]) === -1) {
			cli.error("Field value is not allowed" + obj[field]);
			cli.error(message, obj[field]);
			return false;
		}

		return true;
	}

	PodCreateRequest.prototype.ValidateRawRequest = function(forNumContainers) {
		if (this.RawRequest == null || typeof this.RawRequest == 'undefined') {
			return false;
		}

		if (typeof forNumContainers === 'undefined') {
			forNumContainers = this.Replicas;
		}

		// Validate base object
		if (!validateField(this.RawRequest, 'apiVersion', 'string', kubeAllowedApiVersions, kubeApiVersion, "PodCreateRequest validation failed: Invalid api version '%s'")) {
			return false;
		}

		if (!validateField(this.RawRequest, 'kind', 'string', ['Pod'], 'Pod', "PodCreateRequest validation failed: Invalid object kind '%s'")) {
			return false;
		}

		if (!validateField(this.RawRequest, 'id', 'string', null, null, "PodCreateRequest validation failed: Bad pod id specified")) {
			return false;
		}

		if (!validateField(this.RawRequest, 'labels', 'object', null, null, "PodCreateRequest validation failed: Bad labels specified")) {
			return false;
		}

		if (!validateField(this.RawRequest.labels, 'name', 'string', null, null, "PodCreateRequest validation failed: No name label specified")) {
			return false;
		}

		if (!validateField(this.RawRequest.labels, 'Id', 'string', null, null, "PodCreateRequest validation failed: No id label specified")) {
			return false;
		}

		// Validate desired state
		if (!validateField(this.RawRequest, 'desiredState', 'object', null, null, "PodCreateRequest validation failed: No desiredState specified")) {
			return false;
		}

		if (!validateField(this.RawRequest.desiredState, 'manifest', 'object', null, null, "PodCreateRequest validation failed: No manifest specified")) {
			return false;
		}

		if (!validateField(this.RawRequest.desiredState.manifest, 'id', 'string', null, null, "PodCreateRequest validation failed: No manifest id specified")) {
			return false;
		}

		if (!validateField(this.RawRequest.desiredState.manifest, 'version', 'string', kubeAllowedApiVersions, kubeApiVersion, "PodCreateRequest validation failed: Bad manifest version specified")) {
			return false;
		}

		if (!validateField(this.RawRequest.desiredState.manifest, 'containers', 'object', null, null, "PodCreateRequest validation failed: No manifest containers specified")) {
			return false;
		}

		if (this.RawRequest.desiredState.manifest.containers.length === 0) {
			cli.error("PodCreateRequest validation failed: No containers specified");
			return false;
		}

		var usedPorts = [];
		for (var c in this.RawRequest.desiredState.manifest.containers) {
			var container = this.RawRequest.desiredState.manifest.containers[c];

			if (!validateField(container, 'name', 'string', null, null, "PodCreateRequest validation failed: No container name specified %s")) {
				return false;
			}

			if (!validateField(container, 'version', 'string', kubeAllowedApiVersions, kubeApiVersion, "PodCreateRequest validation failed: No container name specified %s")) {
				return false;
			}

			if (!validateField(container, 'image', 'string', KnownImages, 'dockerfile/nginx', "PodCreateRequest validation failed: Invalid container image %s")) {
				return false;
			}

			if (typeof container.ports !== 'undefined') {				
				for (var p in container.ports) {
					var port = container.ports[p];

					if (!validateField(port, 'containerPort', 'number', null, null, "PodCreateRequest validation failed: No containerPort specified")) {
						return false;
					}

					if (!validateField(port, 'hostPort', 'number', null, null, "PodCreateRequest validation failed: No hostPort specified")) {
						return false;
					}

					if (usedPorts.indexOf(port.hostPort) != -1) {
						cli.error("PodCreateRequest validation failed: Two containers may not have the same host port " + port.hostPort);
						return false;
					}

					usedPorts.push(port.hostPort);

					if (typeof port.protocol !== 'undefined' && !validateField(port, 'protocol', 'string', ['TCP', 'UDP'], 'TCP', "PodCreateRequest validation failed: Invalid container port protocol %s")) {
						return false;
					}

					if (PortManager.PortAvailable(port.hostPort, forNumContainers)) {
						PortManager.AddUsedPort(port.hostPort);
					} else {
						var newPort = PortManager.NextPort(forNumContainers);
						cli.info("PodCreateRequest validation: Notification: Changing port from " + port.hostPort + " to " + newPort);
						port.hostPort = newPort;
					}
				}
			}
		}

		return true;
	}

	return PodCreateRequest;
})();