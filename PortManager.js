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

var PortManager = (function(){
	function PortManager(numMinions) {
		this._numMinions = numMinions;
		this._nextPort = 1024;
		this.Reset();
	}

	PortManager.prototype._computeNextPort = function() {
		var port = this._nextPort;

		while(port in this._ports && this._ports[port] >= this._numMinions) {
			port++;
		}

		this._nextPort = port;

		if (!(this._nextPort in this._ports)) {
			this._ports[this._nextPort] = 0;
		}
	};

	PortManager.prototype.AddUsedPort = function (port) {
		if (port in this._ports) {
			this._ports[port]++;
		} else {
			this._ports[port] = 1;
		}

		if (this._nextPort === port && this._ports[port] === this._numMinions) {
			this._computeNextPort();
		}
	}

	PortManager.prototype.NextPort = function(numReplicas) {
		if (typeof numReplicas != 'number') {
			numReplicas = 1;
		}

		if (numReplicas > this._numMinions) {
			console.error("PortManager Error: cannot get more of a single port than there are minions");
			return null;
		}

		var returnPort = this._nextPort;
		
		while((typeof this._ports[returnPort] !== 'undefined') && (numReplicas + this._ports[returnPort]) > this._numMinions) {
			returnPort += 1;
		}

		if (typeof this._ports[returnPort] === 'undefined') {
			this._ports[returnPort] = numReplicas;
		} else {
			this._ports[returnPort] += numReplicas;
		}

		this._computeNextPort();

		return returnPort;
	}

	PortManager.prototype.PortAvailable = function(port, count) {
		return (count <= this._numMinions) && 
				(
					(typeof this._ports[port] === 'undefined') || 
					(this._ports[port] + count <= this._numMinions)
				);
	}

	PortManager.prototype.Reset = function() {
		this._ports = {};
	}

	return PortManager;
})();

module.exports = { 'PortManager': PortManager };