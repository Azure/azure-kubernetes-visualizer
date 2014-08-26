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

function PodDisplayManager($container){
	var obj = {};
	var podColors = {};
	
	obj.Update = function(pods) {
		// Sort the pods so they don't jump around randomly
		pods.sort(function (a, b) { return a.Name < b.Name; });

		// Get all of the different hosts
		var hosts = {};
		for (var p in pods) {
			var host = (typeof pods[p].Host === 'string' ? pods[p].Host : '').split('.')[0];

			if (host in hosts) {
				hosts[host].push(pods[p]);
			} else {
				hosts[host] = [pods[p]];
			}
		}

		// Get the width for each host
		var width = 99/Object.keys(hosts).length;

		// Empty the current view
		$container.empty();
		$('#nohost').empty();

		// Create each of the hosts containers
		var i = 0;
		var j = 0;
		var slugs = [];
		var hostNames = Object.keys(hosts).sort();
		for (var h in hostNames) {
			var host = hosts[hostNames[h]];
			var nohost = false;
			if ((!hostNames[h] || /^\s*$/.test(hostNames[h]))) {
				// $container.append($('<div class="nohost" id="host-' + i + '"></div>'));
				nohost = true;
			} else {
				$container.append($('<div class="host" id="host-' + i + '" style="width:' + width + '%;"><span class="hostname">' + hostNames[h] + '</span></div>'));
			}

			var $host = nohost ? $('#nohost') : $('#host-' + i);
			for (var p in host) {
				var pod = host[p];
				// var slug = GetNameSlug(pod.Name.split('-')[0]);
				var slug = GetNameSlug(pod.Labels.name);
				var classes = [ 'pod' ];

				var innerhtml = '';
				if (pod.CreateStatus !== false) {
				 	classes.push('creating');
					innerhtml = '<div class="loading"></div>';
				} else {
					classes.push(slug);
					if (slugs.indexOf(slug) === -1) {
						slugs.push(slug);
					}

					for (var c in pod.BaseObject.desiredState.manifest.containers) {
						var container = pod.BaseObject.desiredState.manifest.containers[c];
						var name_split = container.image.split('/');
						var loaded = false;
						try {
							var loaded = container.name in pod.BaseObject.currentState.info;
						} catch (exc) {

						}

						loaded = true;
						innerhtml += '<div class="container container-' + GetNameSlug(container.image) + (loaded ? ' loaded' : ' not-loaded') + '">' + (name_split.length > 1 ? name_split[1] : name_split[0]) + '</div>';
					}
				}

				$host.append('<div id="pod-' + j + '" class="' + classes.join(' ') + '">' + innerhtml + '</div>');
				j++;
			}

			i++;
		}

		// Colourize
		for (var s in slugs) {
			if (!(slugs[s] in podColors)) {
				podColors[slugs[s]] = RandomColourGen.GetRandomColor();
			}
			
			$('.' + slugs[s]).css('background-color', podColors[slugs[s]]);
		}
	}

	function GetNameSlug(name) {
		return name.replace(/[^a-zA-Z0-9]+/g, '').toLowerCase();
	}

	var RandomColourGen = (function(){
		var h = 0;
		var golden_ratio_conjugate = 0.618033988749895;

		var HsvToRgb = function (h, s, v) {
			var h_i = Math.round(h*6);
			var f = h*6 - h_i;
			var p = v * (1-s);
			var q = v * (1-f*s);
			var t =v * (1 - (1-f) * s);

			var result = null;
			switch (h_i) {
				case 0:
					result = [v, t, p];
					break;
				case 1:
					result = [q, v, p];
					break;
				case 2:
					result = [p, v, t];
					break;
				case 3:
					result = [p, q, v];
					break;
				case 4:
					result = [t, p, v];
					break;
				case 5:
				case 6:
					result = [v, p, q];
					break;

			}

			return [Math.round(result[0] * 256), Math.round(result[1] * 256), Math.round(result[2] * 256)];
		}

		return {
			GetRandomColor: function () {
				h =  (h + golden_ratio_conjugate) % 1;
				return 'rgb(' + HsvToRgb(h, 0.5, 0.95).join(',') + ')';
			},

			ResetColors: function() {
				h = 0;
			},
		};
	})();

	return obj;
};