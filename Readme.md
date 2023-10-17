## Apollo Federation Demo

This repository is a demo of using Apollo Federation, used in the [Apollo Router Quickstart](https://www.apollographql.com/docs/router/quickstart/).

### Installation

To run this demo locally, pull down the repository then run the following commands:

```sh
npm install
```

This will install all of the dependencies for each subgraph.

```sh
npm run subgraphs
```

This command will run all of the microservices at once. They can be found at http://localhost:4001, http://localhost:4002, http://localhost:4003, and http://localhost:4004.

In another terminal window, run the router by running this command:

```sh
rover dev --supergraph-config supergraph-dev.yaml
```

This will start up the router and serve it at http://localhost:4000

To generate a supergraph schema and use it with Apollo Router:

```sh
rover supergraph compose --config supergraph.yaml > supergraph.graphql
./router --supergraph supergraph.graphql --dev
```
