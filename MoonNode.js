const { SSL_OP_EPHEMERAL_RSA } = require('constants');

/**
 * Copyright JS Foundation and other contributors, http://js.foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 **/
module.exports = function(RED) {
    function moonNodeConnectorNode(config) {
        RED.nodes.createNode(this,config);
        this.server = config.server;
    };
    RED.nodes.registerType("moonNode-connector",moonNodeConnectorNode,{
        credentials: {
            mrapi: {type:"text"}
        }
    });

    function moonNodeEventNode(n) {
        RED.nodes.createNode(this, n);
        this.name = n.name;
        this.interval = n.interval;
        this.delta = n.delta;
        this.modelPath = n.modelPath;
        this.lastMsgTime = 0;
        this.lastValue = 0;
        var node = this;
        var sndDelta = false;
        var sndInt = false;
        var currDiff = null;

        const jp = require('jsonpath');
        const diff = (a, b) => {
            return Math.abs(a - b);
        };
        
        var processMessage = function(msg) {
            try{
                var patchJSON = msg.payload.patchModel;
                if(patchJSON){
                    var matchInPatch = jp.query(patchJSON, (`$.${node.modelPath}`));
                    if(JSON.stringify(matchInPatch) != "[]"){
                        var matchVal = matchInPatch[0];
                        //we have a match so check if other conditions are met.
                        //check if interval condition is met
                        if(Number(node.interval) > 0 && node.lastMsgTime > 0){
                            var currTime = Date.now();
                            var millInt = (Number(node.interval) * 1000);
                            var millTarget = (node.lastMsgTime + millInt);
                            if (currTime >= millTarget){
                                sndInt = true;
                            }
                        } else {
                            sndInt = true;
                        };
                        //check if delta condition is met
                        if(Number(node.delta) > 0 && !(isNaN(Number(matchVal)))) {
                            currDiff = diff(Number(matchVal), Number(node.lastValue));
                            if (currDiff >= Number(node.delta)){
                                sndDelta = true;
                            };
                        } else {
                            sndDelta = true;
                        };
                        if (sndDelta && sndInt){
                            if (typeof msg.moonNode !== "undefined"){
                                msg.moonNode.eventValue = matchVal;
                                msg.moonNode.lastEventValue = node.lastValue;
                            } else {
                                msg.moonNode = {
                                    eventValue: matchVal,
                                    lastEventValue: node.lastValue
                                };
                            }
                            node.send(msg);
                            node.lastValue = matchVal;
                            node.lastMsgTime = Date.now();
                        };    
                        sndDelta = false;
                        sndInt = false;
                        currDiff = null;
                    };
                };
            } catch{
                //do nothing - here in case a non compliant msg is received
            }
        };
        
        node.on('input', function(msg) {
            processMessage(msg);
        });

    };
    RED.nodes.registerType("moonNode-event", moonNodeEventNode);

    function moonNodeMonitorNode(config) {
        RED.nodes.createNode(this, config);
        this.name = config.name;
        this.server = RED.nodes.getNode(config.server);
        this.wsurl = `ws://${this.server.server}/websocket`;
        this.mrapi = this.server.credentials.mrapi;
        this.autoStart = config.autoStart;
        this.ws = require('ws');
        this.moonNodeFirstMsg = true;
        this.moonNodeFullModel = null;
        this.nodeRun = true;
        this.gotMoonSub = false;
        this.newOpenWS = false;
        this.osKey = null;
        var node = this;
        var msg = null;
        const merge = require('deepmerge')
        const MoonID = Math.floor(Math.random() * (99999 - 10000 + 1)) + 10000;
        const axios = require("axios");

        var sendAlertMsg = function(e) {
            msg = {
                topic:"moonNodeModel", 
                payload: null,
                moonNode: {
                    Error: "Reason = " + e
                }
            };
            node.send(msg);
        };

        const combineMerge = (target, source, options) => {
            const destination = target.slice()
        
            source.forEach((item, index) => {
                if (typeof destination[index] === 'undefined') {
                    destination[index] = options.cloneUnlessOtherwiseSpecified(item, options)
                } else if (options.isMergeableObject(item)) {
                    destination[index] = merge(target[index], item, options)
                } else if (target.indexOf(item) === -1) {
                    destination.push(item)
                }
            })
            return destination
        };

        var restartWS = function(e) {
            msg = {
                topic:"moonNodeModel", 
                payload: null,
                moonNode: {
                    monitorError: "No server defined or cannot connect to the WebSocket. Checking again in 10 seconds : err = " + e
                }
            };
            node.send(msg);
        };
        
        var setupMoonSubscription = function(moonObjects) {
            try {                
                var fullList = JSON.parse(moonObjects);
                var reqObj = {
                    "jsonrpc": "2.0",
                    "method": "printer.objects.subscribe",
                    "params": {
                        "objects": {}
                    },
                    "id": MoonID
                }
                // if(node.osKey !== null){
                //     reqObj["access_token"] = node.osKey;
                // }
                var ni = null;
                //merge tabs
                for(ni in fullList.result.objects){
                    var tmpParam = null;
                    var tmpObj = fullList.result.objects[ni];
                    if(!tmpObj.includes("gcode_macro") && !tmpObj.includes("menu") && !tmpObj.includes("webhooks") && !tmpObj.includes("configfile") && !tmpObj.includes("display_status") && !tmpObj.includes("output_pin beeper") && !tmpObj.includes("virtual_sdcard")){
                        //tmpParam = {tmpObj : null};
                        reqObj.params.objects[tmpObj] = null;
                    }
                }
                node.moonNodeWS.send(JSON.stringify(reqObj));
                return true;
            }catch(e){
                sendAlertMsg("Error getting setting up moonNode subscription = " + e);
                return false;
            }
        }

        var setupMoonws = async function() {                
            //Make an HTTP GET request to get one shot token if API has been provided
            if(node.mrapi){
                //sendAlertMsg("Getting one shot key with API key = " + node.mrapi);
                try{
                    const getOneShotKey = await axios({
                        method: "GET",
                        url: `http://${node.server.server}/access/oneshot_token`,
                        headers: {
                            "Content-Type": "application/json",
                            "X-API-Key": node.mrapi // API KEY
                        }
                    });
                    node.osKey = getOneShotKey.data.result;
                }
                catch(e){
                    node.osKey = null;
                    sendAlertMsg("Failed to connect / authenticate. Check API Key : " + e);
                    return;
                }
            } 
            //open the websocket (use onse shot token if needed)           
            try{
                if(node.nodeRun){
                    if(node.osKey){
                        //sendAlertMsg("Opening WS with OS key = " + node.osKey);
                        node.moonNodeWS = new node.ws(`${node.wsurl}?token=${node.osKey}`);
                    }else {
                        //sendAlertMsg("Opening WS without OS key")
                        node.moonNodeWS = new node.ws(node.wsurl);
                    }
                }
            }
            catch(e){
                node.osKey = null;
                restartWS(e);
                if(node.nodeRun){
                    setTimeout(() => {  setupMoonws(); }, 10000);
                };
            }
            
            node.moonNodeWS.on('error', function (error){
                node.osKey = null;
                restartWS("ws err = " + error);
                if(node.nodeRun){
                    setTimeout(() => {  setupMoonws(); }, 10000);
                };
            });
            
            node.moonNodeWS.on('open', function open() {
                //Get the objects to use
                node.gotMoonSub = false;
                var tmpPayload = {"jsonrpc": "2.0", "method": "printer.objects.list", "id": MoonID};
                //sendAlertMsg("About to subscribe");
                node.moonNodeWS.send(JSON.stringify(tmpPayload));
            });

            node.moonNodeWS.on('message', function incoming(data) {
                if(node.nodeRun){
                    msg = null;
                    var mergedModel = null;
                    var parsedData = null;
                    var tmpFullModel = null
                    if(!node.gotMoonSub){
                        //This is the first data return from moonraker, so use the data to construct the subscription payload.
                        node.gotMoonSub = setupMoonSubscription(data);
                        return;
                    }
                    if(node.moonNodeFirstMsg && node.gotMoonSub){
                        //This is the first data return from moonraker, so use the data to construct the model.
                        tmpFullModel = JSON.parse(data);
                        //need a catch here because of inconsistencies in returned data format
                        try{
                            node.moonNodeFullModel = tmpFullModel.result.status;
                            msg = {
                                topic:"moonNodeModel", 
                                payload: {
                                    fullModel: node.moonNodeFullModel,
                                    patchModel: null,
                                    prevModel: null
                                }
                            };
                            node.send(msg);
                            node.moonNodeFirstMsg = false;
                        }
                        catch{
                            //no action required
                        }
                    } else if(!node.moonNodeFirstMsg && node.gotMoonSub){
                        //merge the update with the model if required
                        tmpFullModel = JSON.parse(data)
                        if(tmpFullModel.method == "notify_status_update"){
                            parsedData = tmpFullModel.params[0];
                            mergedModel = merge(node.moonNodeFullModel, parsedData, { arrayMerge : combineMerge });
                            bHasMsg = false;                                             
                            msg = {
                                topic:"moonNodeModel", 
                                payload: {
                                    fullModel: mergedModel,
                                    patchModel: parsedData,
                                    prevModel:  node.moonNodeFullModel
                                }
                            };
                            node.send(msg);
                            node.moonNodeFullModel = mergedModel;
                            mergedModel = null;
                        }
                    };
                } else {
                    try{
                        node.moonNodeWS.close();
                    }
                    catch {
                        //do nothing
                    }
                }
            });
        };

        
        //run the node
        if (node.server) {          
            if(node.autoStart){
                setupMoonws();
            };
        } else {
            sendAlertMsg("No server defined or cannot connect");
        };

        node.on('close', function() {
            // close ws
            try{
                node.moonNodeWS.close();
            }
            catch {
                //do nothing
            }
        });

        node.on('input', function(msg) {
            //toggle start/stop of polling
            try{
                let toggle = msg.payload.monitorState;
                if(toggle == "ON"){
                    node.nodeRun = true;
                    node.moonNodeFirstMsg = true;
                    setupMoonws();
                }
                else if(toggle == "OFF"){
                    node.nodeRun = false;
                }
            }
            catch(e) {
                //no msg.payload.monitorState was received so take no action just fwd on the msg for completeness
                msg.moonNode = {
                    monitorError: "No monitorState specified or Uncaught Error : err = " + e
                }
                node.send(msg);
            }
        });
    };
    RED.nodes.registerType("moonNode-monitor", moonNodeMonitorNode);

    function moonNodeCommandNode(n) {
        RED.nodes.createNode(this, n);
        this.name = n.name;
        this.command = n.command;
        this.server = RED.nodes.getNode(n.server);
        this.wsurl = `ws://${this.server.server}/websocket`;
        this.mrapi = this.server.credentials.mrapi;
        this.stateless = n.stateless;
        this.ws = require('ws');
        this.currMsg = null;
        this.osKey = null;
        var node = this;
        const MoonID = Math.floor(Math.random() * (99999 - 10000 + 1)) + 10000;
        const axios = require("axios");
        
        var sendAlertMsg = function(e) {
            msg = {
                topic:"moonNodeModel", 
                payload: null,
                moonNode: {
                    Alert: "Reason = " + e
                }
            };
            node.send([null, null, msg]);
        };
        
        var failedCMD = function(e, msg) {
            if (typeof msg.moonNode !== "undefined"){
                msg.moonNode.cmdSent = "ERROR: No Moonraker server defined, or cannot connect. Command has not been sent! : " + e;
            } else {
                msg.moonNode = {cmdSent: "ERROR: No Moonraker server defined, or cannot connect. Command has not been sent! : " + e};
            }
            node.send([null, null, msg]);
        };

        var sendCmdByWS = async function(strCMD) {                
            //Make an HTTP GET request to get one shot token if API has been provided
            if(node.mrapi){
                //sendAlertMsg("Getting one shot key with API key = " + node.mrapi);
                try{
                    const getOneShotKey = await axios({
                        method: "GET",
                        url: `http://${node.server.server}/access/oneshot_token`,
                        headers: {
                            "Content-Type": "application/json",
                            "X-API-Key": node.mrapi // API KEY
                        }
                    });
                    node.osKey = getOneShotKey.data.result;
                }
                catch(e){
                    node.osKey = null;
                    sendAlertMsg("Failed to connect / authenticate. Check API Key : " + e);
                    return;
                }
            } 
            try{
                if(node.osKey){
                    //sendAlertMsg("Opening WS with OS key = " + node.osKey);
                    node.moonNodeWS = new node.ws(`${node.wsurl}?token=${node.osKey}`);
                }else {
                    //sendAlertMsg("Opening WS without OS key")
                    node.moonNodeWS = new node.ws(node.wsurl);
                }
            }
            catch(e){
                node.osKey = null;
                sendAlertMsg("Error opening websocket. The command has not been sent. Error: " + e);
                node.moonNodeWS.close();
                return;
            }
            
            node.moonNodeWS.on('error', function (error){
                node.osKey = null;
                sendAlertMsg("WebSocket Error. The command has not been sent. Error: " + error);
                node.moonNodeWS.close();
                return;
            });
            
            node.moonNodeWS.on('open', function open() {
                //Send the Command
                var tmpPayload = {
                    "jsonrpc": "2.0",
                    "method": "printer.gcode.script",
                    "params": {
                        "script": strCMD
                    },
                    "id": MoonID
                }
                node.moonNodeWS.send(JSON.stringify(tmpPayload));
                if(node.stateless){
                    try{
                        node.moonNodeWS.close();
                    }
                    catch {
                        //do nothing
                    }
                    if(node.currMsg.hasOwnProperty('moonNode')){
                        node.currMsg.moonNode.cmdSent = strCMD;
                        node.currMsg.moonNode.cmdResponse = "Not Applicable : Stateless mode enabled";
                    } else {
                        node.currMsg.moonNode = {"cmdSent": strCMD, "cmdResponse": "Not Applicable : Stateless mode enabled"};
                    }
                    node.send([node.currMsg, null, null]);
                }
            });

            node.moonNodeWS.on('message', function incoming(data) {
                var tmpData = JSON.parse(data);
                if(!node.stateless){
                    if(tmpData.hasOwnProperty('result') || tmpData.hasOwnProperty('error')){
                        if (node.currMsg.hasOwnProperty('moonNode')){
                            node.currMsg.moonNode.cmdSent = strCMD;
                            node.currMsg.moonNode.cmdResponse = tmpData;
                        } else {
                            node.currMsg.moonNode = {"cmdSent": strCMD, "cmdResponse": tmpData};
                        }
                        if(tmpData.hasOwnProperty('error')){
                            node.send([null, null, node.currMsg]);
                        }else {
                        node.send([node.currMsg, null, null]);
                        }
                        try{
                            node.moonNodeWS.close();
                            return;
                        }
                        catch {
                            //do nothing
                            return;
                        }
                    }else if(tmpData.hasOwnProperty('method')) {
                        if(tmpData.method == "notify_gcode_response"){
                            if (node.currMsg.hasOwnProperty('moonNode')){
                                node.currMsg.moonNode.cmdSent = strCMD;
                                node.currMsg.moonNode.cmdResponse = tmpData;
                            } else {
                                node.currMsg.moonNode = {"cmdSent": strCMD, "cmdResponse": tmpData};
                            }
                            node.send([null, node.currMsg, null]);
                        }
                    }
                }
            });
        };
        
        var sndCommand = function(msg) {
            if (node.server) {
                var strCMD = null;

                if (msg.payload.hasOwnProperty('cmd')){
                    strCMD = msg.payload.cmd;
                } else {
                    strCMD = node.command;
                }
                       
                try{
                    sendCmdByWS(strCMD);
                }
                catch(e){
                    failedCMD(e, msg);
                };
            };
        };
        
        node.on('input', function(msg) {
            node.currMsg = msg;
            sndCommand(msg);
        });
        node.on('close', function() {
            // close ws
            try{
                node.moonNodeWS.close();
            }
            catch {
                //do nothing
            }
        });
    };
    RED.nodes.registerType("moonNode-command", moonNodeCommandNode);

}