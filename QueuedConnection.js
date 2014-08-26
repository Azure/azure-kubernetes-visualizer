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

var EventEmitter = require('events').EventEmitter
var https = require('https');

var QueuedConnection = (function(_super){
	function QueuedConnection(requestOptions, requestHandler, responseHandler) {
		// _super.call(this);

		this._options = requestOptions;
		this._requestHandler = requestHandler;
		this._responseHandler = responseHandler;

		return this;
	}

	QueuedConnection.prototype = Object.create(_super.prototype);

	QueuedConnection.prototype.DoConnection = function() {
		var req = https.request(this._options, this._responseHandler);
		req.on('close', _connectionCompleteHandler(this));
		this._requestHandler.call(this, req);
	}

	function _connectionCompleteHandler(obj) {
		return function() {
			obj.emit('complete', obj);
		};
	}

	return QueuedConnection;
})(EventEmitter);

var QueuedConnectionManager = (function(){
	function QueuedConnectionManager(options) {
		this._connectionQueue = [];
		this._activeConnection = null;

		this._connectionOptions = options;
	}

	QueuedConnectionManager.prototype.QueueConnection = function (requestOptions, requestHandler, responseHandler) {
		var connection = new QueuedConnection(requestOptions, requestHandler, responseHandler);

		connection.on('complete', _connectionCompleteHandler(this));

		if (this._activeConnection == null) {
			// No need to queue, do this connection immediately
			this._activeConnection = connection;
			connection.DoConnection();
		} else {
			if (typeof requestOptions['connectionPriority'] != 'undefined' && requestOptions['connectionPriority'] == 'immediate' && this._connectionQueue.length > 5) {
				delete requestOptions['connectionPriority'];
				// this._connectionQueue.splice(0, 0, connection);
				connection.DoConnection();
			} else {
				this._connectionQueue.push(connection);
			}
		}
	}

	QueuedConnectionManager.prototype.GetRequestOptionsForApi = function(apiName, method) {
		var options = {
			'host': this._connectionOptions['host'],
			'port': 443,
			'path': "/" + ["api", this._connectionOptions['apiVersion'], apiName].join("/"),
			'method': typeof method === 'undefined' ? 'GET' : method,
			'rejectUnauthorized': false,
			'requestCert': true,
			'agent': false,
			'auth': this._connectionOptions["user"] + ":" + this._connectionOptions["password"],
		};

		if (typeof this._connectionOptions['options'] !== 'undefined') {
			for (var o in this._connectionOptions['options']) {
				options[o] = this._connectionOptions[o];
			}
		}

		return options;
	}

	QueuedConnectionManager.prototype.DoNextConnection = function() {
		if (this._activeConnection != null) return;
		if (this._connectionQueue.length === 0) return;

		this._activeConnection = this._connectionQueue.splice(0, 1)[0];
		this._activeConnection.DoConnection();
	}

	QueuedConnectionManager.prototype.GetJSONQueryResultConnection = function(requestOptions, resultHander, requestBody) {
		var output = "";
		var error = null;

		var responseHandler = function(res) {
			if (res.statusCode < 200 || res.statusCode >= 300) {
				console.error("Error: Status Code Was %d", res.statusCode, requestOptions.path);
				error = true;
			}

			res.setEncoding("utf8");
			res.on("data", function(chunk){
				output += chunk;
			});
		}

		var requestHandler = function (req) {
			req.on("error", function(err){
				console.error("request error: ", err, requestOptions.path)
				error = err;
			});

			req.on("close", function(){
				if (error != null) {
					resultHander(error, output);
					return;
				}

				var json = null;
				try {
					json = JSON.parse(output)
				} catch (exc) {
					error = exc;
				}

				resultHander(error, json || output)
			});

			switch (typeof requestBody) {
				case 'string':
				case 'number':
					req.write(requestBody);
					break;

				case 'object':
					req.write(JSON.stringify(requestBody));
					break;
			}

			req.setTimeout(30000, function() {console.log("The request timed out")});

			req.end()
		}

		this.QueueConnection(requestOptions, requestHandler, responseHandler);
	}

	function _connectionCompleteHandler(obj) {
		return function(completedConnection) {
			var index = obj._connectionQueue.indexOf(completedConnection);

			if (index !== -1) {
				delete obj._connectionQueue[index];
			}

			if (completedConnection === obj._activeConnection) {
				obj._activeConnection = null;
				obj.DoNextConnection();
			}
		};
	};

	return QueuedConnectionManager;
})();

module.exports = {
	'QueuedConnection': QueuedConnection,
	'QueuedConnectionManager': QueuedConnectionManager,
};