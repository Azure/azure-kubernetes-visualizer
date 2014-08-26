Kubernetes Visualizer
=====================

The demo application helps you visualize what is happening in your Kubernetes cluster by showing you where all of your workloads are being run. This both helps with understanding kubernetes, as well as visually demonstrating how its' scheduler works.

### Running the Demo
The demo application is based off of NodeJS, so you'll need NodeJS at least 0.10.30. You'll also need the following npm modules:

- socket.io
- cli
- express

You can run the `install_packages.sh` script to install these if you already have node and npm installed, or you can install them manually.

#### Configuring the demo

Configuration options are passed to the demo via the command lines. The required options are the url of the Kubernetes server, and the number of minions in the cluster. You can pass this information in directly, or you can run the start_server.sh -- provided you edit it and enter in the path to your checkout of the [Kubernetes repository](https://github.com/GoogleCloudPlatform/kubernetes).

```
$ ./index.js --help

Usage:
  index.js [OPTIONS] [ARGS]

Options: 
  -s, --KubernetesServer URLURL of the Kubernetes Server
  -m, --NumMinions NUMBERNumber of minions in Kubernetes cluster
  -p, --PodRefreshInterval [NUMBER]Time between requesting the list of pods 
                                   from the master (in milliseconds)  (Default is 3000)
  -o, --OperationRefreshInterval [NUMBER]Time between checking the status 
                                         on pending operations (in 
                                         milliseconds)  (Default is 1000)
  -k, --KubePath [PATH]  Kubernetes repo path (Default is ../kubernetes)
  -a, --KubeAuthPath [PATH]Path to the kubernetes authorization file (Default is ~/.kubernetes_auth)
  -v, --KubeApiVersion [STRING]Version of the Kubernetes api to query against  (Default is v1beta1)
  -p, --ListenPort [NUMBER]The port the server should listen on (Default is 3000)
  -r, --MaxReplicas [NUMBER]The maximum number of replicas the server will 
                            allow a client to create at once  (Default is 300)
  -i, --DefaultImage [STRING]The default docker image to use when creating 
                             pods  (Default is dockerfile/nginx)
      --debug            Show debug information
  -h, --help             Display help and usage details
```

### License

Copyright 2014 Microsoft Corporation

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.