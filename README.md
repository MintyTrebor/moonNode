# MoonNode
**MoonNode** is a set of nodes which enable Node-Red to interface with the [Moonraker API](https://moonraker.readthedocs.io/en/latest/web_api/) and [Klipper](https://www.klipper3d.org/).

Moonraker enables websocketed API access to Klipper, which is control software used to execute g-code to operate a physical machine. This is typically used by 3d Printers, CNC machines etc..

MoonNode enables easy connection to Moonraker and constructs a model representing the current state of the entire Machine and its associated components. The model is a JSON object and is constantly updated by Moonraker.

**MoonNode has 4 nodes:**

 - **MoonNode-Connector** *(control node)* : Stores the mode & connection details enabling the web-socket connection to Moonraker.  
 - **MoonNode-Monitor**: Creates the web-socket connection to Moonraker and processes the model updates.
 - **MoonNode-Event** : Parses the updated model for a specified object value change, and triggers when a match if found.
 - **MoonNode-CMD**: Send a g-code or command to Moonraker for action.

 Please referr to the [moonNode wiki] (https://github.com/MintyTrebor/moonNode/wiki) for information on installation and use.
 
 (moonNode IS NOT YET PUBLISHED TO Node-Red REPO)

