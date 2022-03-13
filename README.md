# MoonNode
**MoonNode** is a set of nodes which enable Node-Red to interface with the [Moonraker API](https://moonraker.readthedocs.io/en/latest/web_api/) and [Klipper](https://www.klipper3d.org/).

Moonraker enables websocketed API access to Klipper, which is control software used to execute g-code to operate a physical machine. This is typically used by 3d Printers, CNC machines etc..

MoonNode enables easy connection to Moonraker and constructs a model representing the current state of the Machine objects chosen for monitoring. The model is a JSON object and is constantly updated by Moonraker.

MoonNode has been written to enable easy access to realtime printer/machine status data in NodeRed, which is useful for monitoring multiple printers/machines or integrating the printer/machine into an existing dashboard.

**MoonNode has 4 nodes:**

 - **MoonNode-Connector** *(control node)* : Stores the mode & connection details enabling the web-socket connection to Moonraker.  
 - **MoonNode-Monitor**: Creates the web-socket connection to Moonraker and processes the model updates.
 - **MoonNode-Event** : Parses the updated model for a specified object value change, and triggers when a match if found.
 - **MoonNode-CMD**: Send a g-code or command to Moonraker for action.

 Please referr to the [moonNode wiki](https://github.com/MintyTrebor/moonNode/wiki) for information on installation and use.  
 
 moonNode uses the following libraries/modules:  

 - [DeepMerge](https://www.npmjs.com/package/deepmerge)  
 - [axios](https://www.npmjs.com/package/axios)  
 - [jasonpath](https://www.npmjs.com/package/jsonpath)  
 - [ws](https://www.npmjs.com/package/ws)  

Changelog:  
0.0.4 -- Monitor node now auto recovers should Moonraker disconnect or report errors. Added Connection Msgs output to Monitor Node for debugging connections etc.  
0.0.5 -- Fixed potential issue with keepalive monitor.  
0.0.6-0.0.12 -- Fixed small issues with autorecovery, updated help text, fixed reporting bugs & added more failure conditions to autorecovery.  
0.0.13 -- Monitor node now allows user to choose which machine objects to monitor.  
0.0.14 -- Added filament sensor and display status to the list of monitored objects.  
0.0.15 -- Added ability to set sensor & macro names for selected objects.  
0.0.16 -- Fixed some issues with autostart and error recovery.  
0.0.17 -- Fixed monitor not always stopping on receipt of "OFF" msg.  
0.0.18 -- Changed Monitor Node to get list of subscribable objects from MoonRaker directly, fixed issue with CMD node crashing.  
0.1.01 -- Added Status Indicators to Monitor Node.  
## NOTE: If upgrading from a version prior to V0.0.18 you will need to re-configure all deployed Monitor Nodes.  



