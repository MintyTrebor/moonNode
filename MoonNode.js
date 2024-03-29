const { SSL_OP_EPHEMERAL_RSA } = require('constants');
const { resolve } = require('path');

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
    
    RED.httpAdmin.get("/MRAPISub", RED.auth.needsPermission('moonNode-event.read'), async function(req,res) {
        const axiosSvr = require("axios");
        var mnSvrNode = RED.nodes.getNode(req.query.mnSvrID);
        var mnOneShotToken = null;
        if(mnSvrNode.hasOwnProperty('credentials')){
            if(mnSvrNode.credentials.hasOwnProperty('mrapi')){
                if(mnSvrNode.credentials.mrapi){
                    if(!hasWhiteSpace(mnSvrNode.credentials.mrapi)){
                        //get a oneshot token as API key exists
                        try{
                            mnOneShotToken = await axiosSvr({
                                method: "GET",
                                url: `http://${mnSvrNode.server}/access/oneshot_token`,
                                headers: {
                                    "Content-Type": "application/json",
                                    "X-API-Key": mnSvrNode.credentials.mrapi // API KEY
                                }
                            }).then(res => res.data.result);
                        }catch{
                            res.json({error: "Unable to retrieve token. Check API Key & MoonRaker IP:Port are correct"});
                            return;
                        }
                    } else{
                        res.json({error: "Invalid API Key"});
                        return;
                    }    
                };
            };
        };
        try{
            if(mnOneShotToken){
                const SubObjGet = await axiosSvr.get(`http://${mnSvrNode.server}/printer/objects/list?token=${mnOneShotToken}`).then(res => res.data);
                const SubObj = await SubObjGet;
                if(SubObj){
                    var tmpObj = {objects: []};
                    var cn = 0;
                    var MNObjects = SubObj.result.objects;
                    for(cn in MNObjects){
                        tmpObj.objects.push({object: MNObjects[cn], selected: false});
                    }
                    res.json(tmpObj);
                }
            }else{
                const SubObjGet = await axiosSvr.get(`http://${mnSvrNode.server}/printer/objects/list`).then(res => res.data);
                const SubObj = await SubObjGet;
                if(SubObj){
                    var tmpObj = {objects: []};
                    var cn = 0;
                    var MNObjects = SubObj.result.objects;
                    for(cn in MNObjects){
                        tmpObj.objects.push({object: MNObjects[cn], selected: false});
                    }
                    res.json(tmpObj);
                }
            }
        }catch{
            res.json({error: "Failed to retrieve data from MoonRaker. Check MoonRaker is available & the IP:Port are correct. If you have enabled Authorisation then ensure you have set the API key."});
        }
        
    });
    
    function moonNodeConnectorNode(config) {
        RED.nodes.createNode(this,config);
        this.server = config.server;
    };
    RED.nodes.registerType("moonNode-connector",moonNodeConnectorNode,{
        credentials: {
            mrapi: {type:"text"}
        }
    });

    function hasWhiteSpace(s){
        return /\s/g.test(s);
    }

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
        this.mObjSel = config.mObjSel;
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
            node.send([null, msg, null]);
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
                    monitorError: "Restarting Websocket : Reason = " + e
                }
            };
            node.send([null, msg, null]);
            node.normClose = true;
            node.moonNodeFirstMsg = true;
            node.status({fill:"yellow",shape:"dot",text:"disconnected"});
            try{
                node.printerReady = false;
                node.gotPrinterStatus = false;
                node.subscribed = false;
                node.gotMoonSub = false;
                //node.moonNodeWS = null;
                if(node.moonNodeWS){
                    node.moonNodeWS.terminate();
                }
                node.moonNodeWS = null;
            }catch{
                ///
            }
            if(node.nodeRun){
                setTimeout(() => {  
                    node.inRestart = false;
                    setupMoonws();     
                }, 10000);
            }
            else{
                node.inRestart = false;
                node.status({fill:"red",shape:"dot",text:"Stopped"});
            }
        };

        var getPrinterStatus = function(){
            try {                
                var reqObj = {
                    "jsonrpc": "2.0",
                    "method": "printer.info",
                    "id": MoonID
                }
                node.moonNodeWS.send(JSON.stringify(reqObj));
                //sendAlertMsg("Sent Printer Status Request");
                return true;
            }catch(e){
                if(!node.inRestart){
                    node.inRestart = true;
                    restartWS("Error Sending Request for Moonraker Status Information: = " + e)
                    node.status({fill:"yellow",shape:"dot",text:"error"});
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
                    sendAlertMsg("Moonraker not ready. Will check again shortly. Status: = " + fullList.result.state);
                    node.status({fill:"yellow",shape:"dot",text:"error"});
                    return false;
                }
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
                var l = 0
                if(node.mObjSel){
                    for(l in node.mObjSel){
                        reqObj.params.objects[`${node.mObjSel[l]}`] = null;
                    }
                    node.moonNodeWS.send(JSON.stringify(reqObj));
                    return true;
                }else {
                    return false;
                }
                
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
                    node.status({fill:"yellow",shape:"dot",text:"error"});
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

            //node.moonNodeWS.on('ping', heartbeat);
            if(node.moonNodeWS){
                node.moonNodeWS.on('error', function (error){
                    node.osKey = null;
                    if(!node.inRestart){
                        node.inRestart = true;
                        node.status({fill:"yellow",shape:"dot",text:"disconnected"});
                        restartWS("Websocket Error = " + error);
                    }
                    node.normClose = false;
                    node.printerReady = false;
                    node.gotPrinterStatus = false;
                });
                
                node.moonNodeWS.on('open', function open() {
                    //heartbeat;
                    //Get the objects to use
                    node.gotMoonSub = false;
                    if(!node.printerReady && !node.gotPrinterStatus){
                        sendAlertMsg("Opened Websocket - Gettings Moonraker Status");
                        node.status({fill:"green",shape:"dot",text:"connected"});
                        node.gotPrinterStatus = getPrinterStatus();
                        node.inRestart = false;
                    }                
                });

                node.moonNodeWS.on('close', function close(e) {
                    //Get the objects to use
                    node.gotMoonSub = false;
                    node.printerReady = false;
                    //node.status({fill:"red",shape:"dot",text:"Stopped"});
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
                        var tmpFullModel = null;
                        var tmpPrevData = null;
                        var rawMSG = null;
                        if(!node.printerReady && node.gotPrinterStatus){
                            //sendAlertMsg("Moonraker Status: = " + JSON.stringify(data));
                            node.printerReady = checkIfPrinterReady(data);
                            if(!node.printerReady){
                                node.gotPrinterStatus = false;
                                //moonraker is responding but printer is not ready so check again in 10 seconds
                                setTimeout(() => {  
                                    node.gotPrinterStatus = getPrinterStatus();     
                                }, 10000);
                            }
                            return;
                        }
                        if(node.printerReady && !node.gotMoonSub){
                            node.gotMoonSub = setupMoonSubscription(data);
                            return;
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
                                rawMSG = {
                                    topic:"RAWJSON", 
                                    payload: {
                                        RAW: tmpFullModel
                                    }
                                };
                                node.send([msg, null, rawMSG]);
                                node.moonNodeFirstMsg = false;
                                return;
                            }
                            else{
                                return;
                            }
                        } else if(!node.moonNodeFirstMsg && node.gotMoonSub && node.printerReady){
                            //merge the update with the model if required
                            tmpFullModel = JSON.parse(data)
                            if(tmpFullModel.method == "notify_status_update"){
                                parsedData = tmpFullModel.params[0];
                                tmpPrevData = JSON.parse(JSON.stringify(node.moonNodeFullModel));
                                //deal with postion data - allways replace never merge
                                if(parsedData.hasOwnProperty('toolhead')){
                                    if(parsedData.toolhead.hasOwnProperty('position')){
                                        node.moonNodeFullModel.toolhead.position = {};
                                    }
                                }
                                mergedModel = merge(node.moonNodeFullModel, parsedData, { arrayMerge : combineMerge });
                                bHasMsg = false;                                             
                                msg = {
                                    topic:"moonNodeModel", 
                                    payload: {
                                        fullModel: mergedModel,
                                        patchModel: parsedData,
                                        prevModel:  tmpPrevData
                                    }
                                };
                                rawMSG = {
                                    topic:"RAWJSON", 
                                    payload: {
                                        RAW: tmpFullModel
                                    }
                                };
                                node.send([msg, null, rawMSG]);
                                node.moonNodeFullModel = mergedModel;
                                mergedModel = null
                                return;
                            }
                            else if(tmpFullModel.method == "notify_klippy_disconnected"){
                                bHasMsg = false;
                                if(!node.inRestart){
                                    node.printerReady = false;
                                    node.gotPrinterStatus = false;
                                    node.inRestart = true;
                                    restartWS("Klippy Disconnected");
                                }
                                return;
                            }else if(tmpFullModel.method == "notify_klippy_shutdown"){
                                bHasMsg = false;
                                if(!node.inRestart){
                                    node.printerReady = false;
                                    node.gotPrinterStatus = false;
                                    node.inRestart = true;
                                    restartWS("Klippy Shutdown");
                                }
                                return;
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
            }else{
                node.osKey = null;
                if(!node.inRestart){
                    node.inRestart = true;
                    node.status({fill:"yellow",shape:"dot",text:"disconnected"});
                    restartWS("No Connection");
                }
                node.normClose = false;
                node.printerReady = false;
                node.gotPrinterStatus = false;
            }
        };

        node.status({fill:"red",shape:"dot",text:"Stopped"});
        //run the node
        if (node.server) {          
            
            if(node.autoStart){
                node.status({fill:"green",shape:"ring",text:"starting"});
                node.nodeRun = true;
                node.moonNodeFirstMsg = true;
                node.printerReady = false;
                node.gotPrinterStatus = false;
                node.subscribed = false;
                node.gotMoonSub = false;
                setupMoonws();
            };
        } else {
            sendAlertMsg("No server defined or cannot connect");
            node.status({fill:"yellow",shape:"dot",text:"No Connection"});
        };

        node.on('close', function() {
            // close ws
            node.nodeRun = false;    
            node.normClose = true;
            node.status({fill:"red",shape:"dot",text:"Stopped"});
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
                    node.status({fill:"green",shape:"ring",text:"starting"});
                    node.nodeRun = true;
                    node.moonNodeFirstMsg = true;
                    node.printerReady = false;
                    node.gotPrinterStatus = false;
                    node.normClose = true;
                    node.subscribed = false;
                    node.gotMoonSub = false;
                    setupMoonws();
                }
                else if(toggle == "OFF"){
                    node.nodeRun = false;
                    node.normClose = true;
                    node.status({fill:"red",shape:"dot",text:"Stopped"});
                    try{
                        //if(node.moonNodeWS){
                            node.moonNodeWS.close();
                        //}
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
                node.send([null, msg, null]);
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
        this.MoonID = null;
        this.wsOpen = false;
        this.cmdArr = [];
        this.moonNodeWS = null;
        this.sndMsg1 = null;
        this.sndMsg2 = null;
        this.sndMsg3 = null;
        this.msgQueue = [];
        var node = this;
        const axios = require("axios");
        
        async function sendHTTPGCodeCmd(msg){
            return new Promise((resolve, reject) => {
                var strCMD = null;
                if (msg.hasOwnProperty('payload')){
                    if (msg.payload.hasOwnProperty('cmd')){
                        strCMD = msg.payload.cmd;
                    } else {
                        strCMD = node.command;
                    }
                } else {
                    strCMD = node.command;
                }
                let tmpHeaders = {
                    "Content-Type": "application/json"
                }
                if(node.mrapi){
                    //console.log("Using API Key")
                    tmpHeaders = {
                        "Content-Type": "application/json",
                        "X-API-Key": node.mrapi // API KEY
                    }
                }
                //console.log("CMD", strCMD)
                axios({
                    method: "GET",
                    url: `http://${node.server.server}/printer/gcode/script?script=${strCMD}`,
                    headers: tmpHeaders
                })
                .then((response) => {
                    resolve(response)
                })
                .catch((error) => {
                    reject(error);
                })
            });
        }

        async function handleMessage(currMsg, currSend, currDone){
            const sendCmd = await sendHTTPGCodeCmd(currMsg)
            .then(res => {
                //console.log("data", res.data)
                node.sndMsg1 = currMsg;
                if(res.message) {
                    node.sndMsg3 = res.message;
                }
                if(res.data){
                    node.sndMsg2 = res.data;
                }
                //console.log("res", res)
                if(!node.stateless){currSend([node.sndMsg1, node.sndMsg2, node.sndMsg3], false)};
                currDone();
                node.msgQueue.shift()
                if (node.msgQueue.length > 0) {
                    handleMessage(node.msgQueue[0].thisMsg, node.msgQueue[0].thisSend, node.msgQueue[0].thisDone)
                }
            }).catch(e => {
                //console.log("res e", e)
                node.sndMsg1 = currMsg;
                node.sndMsg3 = e.message;
                currSend([node.sndMsg1, node.sndMsg2, node.sndMsg3], false);
                currDone();
                node.msgQueue.shift()
                if (node.msgQueue.length > 0) {
                    handleMessage(node.msgQueue[0].thisMsg, node.msgQueue[0].thisSend, node.msgQueue[0].thisDone)
                }
            });
        }

            
        node.on('input', async function(msg, send, done) {
            // If this is pre-1.0, 'send' will be undefined, so fallback to node.send
            send = send || function() { node.send.apply(node,arguments) }
            //check for cancel command first
            var strCMD = null;
            if (msg.hasOwnProperty('payload')){
                if (msg.payload.hasOwnProperty('cmd')){
                    strCMD = msg.payload.cmd;
                } else {
                    strCMD = node.command;
                }
            } else {
                strCMD = node.command;
            }
            if(strCMD === 'CANCEL'){
                //clear current queue
                node.msgQueue = [];
                send(['Cancelled By User', 'Cancelled By User', 'Cancelled By User']);
                done();
            }else{
                //process as normal
                node.msgQueue.push( {thisMsg: msg, thisSend: send, thisDone: done} )
                if (node.msgQueue.length == 1) {
                    handleMessage(node.msgQueue[0].thisMsg, node.msgQueue[0].thisSend, node.msgQueue[0].thisDone)
                }
            }
        });
        node.on('close', function() {
            // close ws
            try{
                node.wsOpen = false;
                node.moonNodeWS.close();
            }
            catch {
                //do nothing
            }
        });
    };
    RED.nodes.registerType("moonNode-command", moonNodeCommandNode);

}
