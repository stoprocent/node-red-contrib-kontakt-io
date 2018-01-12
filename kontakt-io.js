
module.exports = function(RED) {
    "use strict";

    var mqtt = require('mqtt');

    function matchTopic(ts, t) {
        var re = new RegExp("^"+ts.replace(/([\[\]\?\(\)\\\\$\^\*\.|])/g,"\\$1").replace(/\+/g,"[^/]+").replace(/\/#$/,"(\/.*)?")+"$");
        return re.test(t);
    }

    /* ***************************************************************** */

    function AccountNode(n) {
        RED.nodes.createNode(this, n);

        this.apikey         = this.credentials.apikey
        this.environment    = n.environment;
        this.name           = n.name;
        this.connected      = false;
        this.connecting     = false;
        this.closing        = false;
        this.subscriptions  = {};
        this.users          = {};

        // Build Vars
        this.clientID       = 'kontakt_io_' + (1 + Math.random() * 4294967295).toString(16);
        this.environmentURL = "mqtts://" + this.environment + ":8083";

        var node = this;

        this.register = function(mqttNode) {
            node.users[mqttNode.id] = mqttNode;
            if (Object.keys(node.users).length === 1) {
                node.connect();
            }
        };

        this.deregister = function(mqttNode,done) {
            delete node.users[mqttNode.id];
            if (node.closing) {
                return done();
            }
            if (Object.keys(node.users).length === 0) {
                if (node.client && node.client.connected) {
                    return node.client.end(done);
                } else {
                    node.client.end();
                    return done();
                }
            }
            done();
        };

        this.connect = function () {
            if (node.connected || node.connecting) return;
            node.connecting = true;
            node.client = mqtt.connect(node.environmentURL, {
                clientId: node.clientID,
                username: node.clientID,
                password: node.apikey
            });

            node.client.setMaxListeners(0);

            // Register successful connect or reconnect handler
            node.client.on('connect', function () {
                node.connecting = false;
                node.connected = true;

                node.log(RED._("mqtt.state.connected", { broker: (node.clientID + "@") + node.environmentURL }));

                for (var id in node.users) {
                    if (node.users.hasOwnProperty(id)) {
                        node.users[id].status({ fill:"green", shape:"dot", text:"node-red:common.status.connected" });
                    }
                }
                
                // Remove any existing listeners before resubscribing to avoid duplicates in the event of a re-connection
                node.client.removeAllListeners('message');

                // Re-subscribe to stored topics
                for (var s in node.subscriptions) {
                    if (node.subscriptions.hasOwnProperty(s)) {
                        var topic = s;
                        var qos = 0;
                        for (var r in node.subscriptions[s]) {
                            if (node.subscriptions[s].hasOwnProperty(r)) {
                                qos = Math.max(qos, node.subscriptions[s][r].qos);
                                node.client.on('message', node.subscriptions[s][r].handler);
                            }
                        }
                        var options = { qos: qos };
                        node.client.subscribe(topic, options);
                    }
                }
            });

            node.client.on("reconnect", function() {
                for (var id in node.users) {
                    if (node.users.hasOwnProperty(id)) {
                        node.users[id].status({ fill:"yellow", shape:"ring", text:"node-red:common.status.connecting" });
                    }
                }
            });

            // Register disconnect handlers
            node.client.on('close', function () {
                if (node.connected) {
                    node.connected = false;

                    node.log(RED._("mqtt.state.disconnected", { broker: (node.clientID + "@") + node.environmentURL }));
                    
                    for (var id in node.users) {
                        if (node.users.hasOwnProperty(id)) {
                            node.users[id].status({ fill:"red", shape:"ring", text:"node-red:common.status.disconnected" });
                        }
                    }
                } else if (node.connecting) {
                    node.log(RED._("mqtt.state.connect-failed", { broker: (node.clientID + "@") + node.environmentURL }));
                }
            });

            // Register connect error handler
            node.client.on('error', function (error) {
                if (node.connecting) {
                    node.client.end();
                    node.connecting = false;
                }
            });
        };

        this.subscribe = function (topic, qos, ref, callback) {
            ref = ref||0;
            node.subscriptions[topic] = node.subscriptions[topic]||{};
            var sub = {
                topic: topic,
                qos: qos,
                handler: function(mtopic, mpayload, mpacket) {
                    if (matchTopic(topic, mtopic)) {
                        callback(mtopic, JSON.parse(mpayload.toString('utf-8')), mpacket);
                    }
                },
                ref: ref
            };
            node.subscriptions[topic][ref] = sub;
            if (node.connected) {
                node.client.on('message', sub.handler);
                var options = {};
                options.qos = qos;
                node.client.subscribe(topic, options);
            }
        };

        this.unsubscribe = function (topic, ref) {
            ref = ref||0;
            var sub = node.subscriptions[topic];
            if (sub) {
                if (sub[ref]) {
                    node.client.removeListener('message',sub[ref].handler);
                    delete sub[ref];
                }
                if (Object.keys(sub).length === 0) {
                    delete node.subscriptions[topic];
                    if (node.connected) {
                        node.client.unsubscribe(topic);
                    }
                }
            }
        };

        this.on('close', function(done) {
            this.closing = true;
            if (this.connected) {
                this.client.once('close', function() {
                    done();
                });
                this.client.end();
            } else if (this.connecting || node.client.reconnecting) {
                node.client.end();
                done();
            } else {
                done();
            }
        });

    }
    RED.nodes.registerType("kontakt-io-account", AccountNode, {
        credentials: {
            apikey: {type: "password"}
        }
    });

    /* ***************************************************************** */

    function PresenceInNode(n) {
        RED.nodes.createNode(this, n);

        this.account        = n.account;
        this.source         = n.source;
        this.presenceID     = n.presenceID;
        this.trackingID     = n.trackingID;
        this.proximity      = n.proximity;
        this.subscription   = "/presence/stream/" + this.presenceID;

        this.account = RED.nodes.getNode(this.account);

        var node = this;

         if (this.account && this.presenceID) {

            this.status({ fill:"red", shape:"ring", text:"node-red:common.status.disconnected" });

            this.account.register(this);
            this.account.subscribe(this.subscription, 2, this.id, function(topic, payload, packet) {

                if (node.trackingID || node.proximity) {
                    payload = payload.filter(function(element, index, array) {
                        return ((node.trackingID && node.trackingID == element.trackingId) || !node.trackingID) && 
                        ((node.proximity && node.proximity == element.proximity) || !node.proximity)

                    });
                }

                var msg = {
                    topic: node.source + "/" + node.presenceID + (node.trackingID ? "/" + node.trackingID : "") + (node.proximity ? "/" + node.proximity : ""), 
                    payload: ((node.trackingID && payload.length) === 1 ? payload[0]: payload)
                };

                node.send(msg);
            });

            if (this.account.connected) {
                node.status({fill:"green", shape:"dot", text:"node-red:common.status.connected"});
            }

            this.on('close', function(done) {
                if (node.account) {
                    node.account.unsubscribe(node.subscription, node.id);
                    node.account.deregister(node, done);
                }
            });
        } else {
            this.error(RED._("mqtt.errors.missing-config"));
            this.status({ fill:"red", shape:"ring", text:"node-red:common.status.disconnected" });
        }
    }
    RED.nodes.registerType("kontakt.io-presence", PresenceInNode);

    function TelemetryInNode(n) {
        RED.nodes.createNode(this, n);

        this.account        = n.account;
        this.uniqueID       = n.uniqueID;
        this.stream         = n.stream;
        this.subscription   = "/stream/" + this.uniqueID + "/" + this.stream;

        this.account = RED.nodes.getNode(this.account);

        var node = this;

         if (this.account && this.uniqueID && this.stream) {

            this.status({ fill:"red", shape:"ring", text:"node-red:common.status.disconnected" });

            this.account.register(this);
            this.account.subscribe(this.subscription, 2, this.id, function(topic, payload, packet) {

                var msg = {
                    topic: node.uniqueID + "/" + node.stream,
                    payload: payload
                };

                node.send(msg);
            });

            if (this.account.connected) {
                node.status({fill:"green", shape:"dot", text:"node-red:common.status.connected"});
            }

            this.on('close', function(done) {
                if (node.account) {
                    node.account.unsubscribe(node.subscription, node.id);
                    node.account.deregister(node, done);
                }
            });
        } else {
            this.error(RED._("mqtt.errors.missing-config"));
            this.status({ fill:"red", shape:"ring", text:"node-red:common.status.disconnected" });
        }
    }
    RED.nodes.registerType("kontakt.io-telemetry", TelemetryInNode);
};
