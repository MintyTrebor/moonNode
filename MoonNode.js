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
                    var matchInPatch = jp.query(patchJSON, (`$..${node.modelPath}`));
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
        this.mObjPR = config.mObjPR;
        this.mObjProbe = config.mObjProbe;
        this.mObjES = config.mObjES;
        this.mObjTSCh = config.mObjTSCh;
        this.mObjHeatBed = config.mObjHeatBed;
        this.mObjExFan = config.mObjExFan;
        this.mObjTH = config.mObjTH;
        this.mObjGMov = config.mObjGMov;
        this.mObjTSrPi = config.mObjTSrPi;
        this.mObjTHrPi = config.mObjTHrPi;
        this.mObjVDSC = config.mObjVDSC;
        this.mObjSysStat = config.mObjSysStat;
        this.mObjITO = config.mObjITO;
        this.mObjFan = config.mObjFan;
        this.mObjBMesh = config.mObjBMesh;
        this.mObjPrStat = config.mObjPrStat;
        this.mObjExt = config.mObjExt;
        this.mObjDispStat = config.mObjDispStat;
        this.mObjFilSen = config.mObjFilSen;
        this.ws = require('ws');
        this.moonNodeFirstMsg = true;
        this.moonNodeFullModel = null;
        this.nodeRun = true;
        this.gotMoonSub = false;
        this.newOpenWS = false;
        this.osKey = null;
        this.normClose = false;
        this.printerReady = false;
        this.gotPrinterStatus = false;
        this.gotPrinterObjects = false;
        this.subscribed = false;
        this.lastMsgTime = null;
        this.stopKeepAlive = false;
        this.inRestart = false;
        var node = this;
        var msg = null;
        var MoonID = null;
        const merge = require('deepmerge')
        const axios = require("axios");
        const jp = require('jsonpath');

        function getMoonID() {
            return Math.floor(Math.random() * (99999 - 10000 + 1)) + 10000;
        };

        function heartbeat() {
            clearTimeout(this.pingTimeout);
            this.pingTimeout = setTimeout(() => {
                if(!node.inRestart){
                    node.inRestart = true;
                    restartWS("TimeOut Resetting Connection to Moonraker");
                }
            }, 20000 + 1000);
        }
        
        var sendAlertMsg = function(e) {
            msg = {
                topic:"moonNodeModel", 
                payload: null,
                moonNode: {
                    alert: e
                }
            };
            node.send([null, msg]);
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
            node.inRestart = true;
            clearTimeout(this.pingTimeout);
            msg = {
                topic:"moonNodeModel", 
                payload: null,
                moonNode: {
                    monitorError: "Restarting Websocket in 10 seconds : Reason = " + e
                }
            };
            node.send([null, msg]);
            node.normClose = true;
            node.moonNodeFirstMsg = true;
            try{
                node.printerReady = false;
                node.gotPrinterObjects = false;
                node.gotPrinterStatus = false;
                node.subscribed = false;
                node.gotMoonSub = false;
                //node.moonNodeWS = null;
                if(node.moonNodeWS){
                    node.moonNodeWS.terminate();
                }
            }catch{
                ///
            }
            if(node.nodeRun){
                setTimeout(() => {  
                    node.inRestart = false;
                    setupMoonws();     
                }, 10000);
            }
            node.inRestart = false;
        };

        var getPrinterStatus = function(){
            try {                
                var reqObj = {
                    "jsonrpc": "2.0",
                    "method": "printer.info",
                    "id": MoonID
                }
                node.moonNodeWS.send(JSON.stringify(reqObj));
                return true;
            }catch(e){
                if(!node.inRestart){
                    node.inRestart = true;
                    restartWS("Error getting Moonraker Status Information: = " + e)
                };
                return false;
            }
        };

        var checkIfPrinterReady = function(moonObjects) {
            try {                
                var fullList = JSON.parse(moonObjects)
                if(fullList.result.state === "ready"){
                    return true;
                }else{
                    return false;
                }
            }catch(e){
                return false;
            }
        };

        var getPrinterObjects = function(){
            //sendAlertMsg("RUNNING getPrinterObjects");
            try {                
                var reqObj = {
                    "jsonrpc": "2.0",
                    "method": "printer.objects.list",
                    "id": MoonID
                }
                node.moonNodeWS.send(JSON.stringify(reqObj));
                return true;
            }catch(e){
                return false;
            }
        };
        
        var setupMoonSubscription = function(moonObjects) {
            //sendAlertMsg("RUNNING setupMoonSubscription");
            try {                
                //sendAlertMsg(JSON.stringify(moonObjects));
                var fullList = JSON.parse(moonObjects);
                var reqObj = {
                    "jsonrpc": "2.0",
                    "method": "printer.objects.subscribe",
                    "params": {
                        "objects": {}
                    },
                    "id": MoonID
                }
                var ni = null;
                if(node.mObjPR){reqObj.params.objects["pause_resume"] = null;};
                if(node.mObjProbe){reqObj.params.objects["probe"] = null;};
                if(node.mObjES){reqObj.params.objects["query_endstops"] = null;};
                if(node.mObjTSCh){reqObj.params.objects["temperature_sensor chamber"] = null;};
                if(node.mObjHeatBed){reqObj.params.objects["heater_bed"] = null;};
                if(node.mObjExFan){reqObj.params.objects["heater_fan extruder_fan"] = null;};
                if(node.mObjTH){reqObj.params.objects["toolhead"] = null;};
                if(node.mObjGMov){reqObj.params.objects["gcode_move"] = null;};
                if(node.mObjTSrPi){reqObj.params.objects["temperature_sensor raspberry_pi"] = null;};
                if(node.mObjTHrPi){reqObj.params.objects["temperature_host raspberry_pi"] = null;};
                if(node.mObjVDSC){reqObj.params.objects["virtual_sdcard"] = null;};
                if(node.mObjSysStat){reqObj.params.objects["system_stats"] = null;};
                if(node.mObjITO){reqObj.params.objects["idle_timeout"] = null;};
                if(node.mObjFan){reqObj.params.objects["fan"] = null;};
                if(node.mObjBMesh){reqObj.params.objects["bed_mesh"] = null;};
                if(node.mObjPrStat){reqObj.params.objects["print_stats"] = null;};
                if(node.mObjExt){reqObj.params.objects["extruder"] = null;};
                if(node.mObjFilSen){reqObj.params.objects["filament_switch_sensor"] = null;};
                if(node.mObjDispStat){reqObj.params.objects["display_status"] = null;};
                node.moonNodeWS.send(JSON.stringify(reqObj));
                return true;
            }catch(e){
                return false;
            }
        }

        


        var setupMoonws = async function() {                
            //Make an HTTP GET request to get one shot token if API has been provided
            if(node.mrapi){
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
                    sendAlertMsg("Error getting OneShot Auth Key : " + e);
                    node.osKey = null;
                }
            } 
            //open the websocket (use onse shot token if needed)           
            try{
                if(node.nodeRun){
                    MoonID = getMoonID();
                    if(node.osKey){
                        //sendAlertMsg("Opening WS with OS key = " + node.osKey);
                        node.moonNodeWS = new node.ws(`${node.wsurl}?token=${node.osKey}`);
                    }else {
                        //sendAlertMsg("Opening WS without OS key")
                        node.moonNodeWS = new node.ws(node.wsurl);
                    }
                }
            }
            catch{
                node.moonNodeWS = null;
            }

            node.moonNodeWS.on('ping', heartbeat);
            
            node.moonNodeWS.on('error', function (error){
                node.osKey = null;
                if(!node.inRestart){
                    node.inRestart = true;
                    restartWS("Websocket Error = " + error);
                }
                node.normClose = false;
                node.printerReady = false;
            });
            
            node.moonNodeWS.on('open', function open() {
                heartbeat;
                //Get the objects to use
                node.gotMoonSub = false;
                if(!node.printerReady && !node.gotPrinterStatus){
                    sendAlertMsg("Opened Websocket Gettings Moonraker Status");
                    node.gotPrinterStatus = getPrinterStatus();
                    node.inRestart = false;
                }                
            });

            node.moonNodeWS.on('close', function close(e) {
                //Get the objects to use
                node.gotMoonSub = false;
                node.printerReady = false;
                if(e == 1005){
                    if(node.nodeRun && !node.inRestart){
                        node.inRestart = true;
                        restartWS("Websocket closed");
                    }
                }
            });

            node.moonNodeWS.on('message', function incoming(data) {
                node.inRestart = false;
                if(node.nodeRun){
                    msg = null;
                    var mergedModel = null;
                    var parsedData = null;
                    var tmpFullModel = null
                    if(!node.printerReady && node.gotPrinterStatus){
                        //sendAlertMsg("Moonraker Status: = " + JSON.stringify(data));
                        node.printerReady = checkIfPrinterReady(data);
                        if(!node.printerReady){
                            node.gotPrinterStatus = getPrinterStatus();
                        }
                        return;
                    }
                    if(node.printerReady && !node.gotPrinterObjects){
                        sendAlertMsg("Gettings Printer Objects");
                        node.gotPrinterObjects = getPrinterObjects();
                        if(!node.gotPrinterObjects){
                            node.printerReady = false;
                            node.gotPrinterStatus = false;
                            node.gotPrinterStatus = getPrinterStatus();
                        }
                        return;
                    }
                    if(node.printerReady && node.gotPrinterObjects && !node.gotMoonSub){
                        var tmpRetObj = JSON.parse(data);
                        var matchInPatch = jp.query(tmpRetObj, (`$..result.objects`));
                        if(JSON.stringify(matchInPatch) != "[]"){
                            //sendAlertMsg("Printer Objects: = " + JSON.stringify(data));
                            node.gotMoonSub = setupMoonSubscription(data);
                        }else{
                            node.gotMoonSub = false;
                        }
                        //now we are in normal mode so setup keep alive
                        if(!node.gotMoonSub){
                            node.gotPrinterObjects = getPrinterObjects();  
                            return;                           
                        }
                    }
                    if(node.moonNodeFirstMsg && node.gotMoonSub && node.printerReady){
                        //This is the first data return from moonraker, so use the data to construct the model.
                        tmpFullModel = JSON.parse(data);
                        //need a catch here because of inconsistencies in returned data format
                        var matchInPatch = jp.query(tmpFullModel, (`$..result.status`));
                        if(JSON.stringify(matchInPatch) != "[]"){
                            node.moonNodeFullModel = tmpFullModel.result.status;
                            msg = {
                                topic:"moonNodeModel", 
                                payload: {
                                    fullModel: node.moonNodeFullModel,
                                    patchModel: null,
                                    prevModel: null
                                }
                            };
                            node.send([msg, null]);
                            node.moonNodeFirstMsg = false;
                        }
                        else{
                            
                        }
                    } else if(!node.moonNodeFirstMsg && node.gotMoonSub && node.printerReady){
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
                            node.send([msg, null]);
                            node.moonNodeFullModel = mergedModel;
                            mergedModel = null
                        }
                        else if(tmpFullModel.method == "notify_klippy_disconnected"){
                            bHasMsg = false;
                            if(!node.inRestart){
                                node.inRestart = true;
                                restartWS("Klippy Disconnected");
                            }
                            
                        }else if(tmpFullModel.method == "notify_klippy_shutdown"){
                            bHasMsg = false;
                            if(!node.inRestart){
                                node.inRestart = true;
                                restartWS("Klippy Shutdown");
                            }
                            
                        }
                    };
                } else {
                    try{
                        if(node.moonNodeWS){
                            node.normClose = true;
                            node.moonNodeWS.close();
                        }
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
                if(node.moonNodeWS){
                    node.normClose = true;
                    node.moonNodeWS.close();
                }
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
                    node.printerReady = false;
                    node.gotPrinterObjects = false;
                    node.gotPrinterStatus = false;
                    node.normClose = true;
                    node.subscribed = false;
                    node.gotMoonSub = false;
                    setupMoonws();
                }
                else if(toggle == "OFF"){
                    node.nodeRun = false;
                    node.normClose = true;
                    
                    try{
                        if(node.moonNodeWS){
                            node.moonNodeWS.close();
                        }
                    }catch{
                        //
                    }
                }
            }
            catch(e) {
                //no msg.payload.monitorState was received so take no action just fwd on the msg for completeness
                msg.moonNode = {
                    monitorError: "No monitorState specified or Uncaught Error : err = " + e
                }
                node.send([null, msg]);
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
