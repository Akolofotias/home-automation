/*** Z-Wave Binding module ********************************************************

Version: 2.3.1
-------------------------------------------------------------------------------
Author: Serguei Poltorak <ps@z-wave.me>, Niels Roche <nir@zwave.eu>
Copyright: (c) Z-Wave.Me, 2014

******************************************************************************/

function ZWave (id, controller) {

	// if called without "new", return list of loaded Z-Way instances
	if (!(this instanceof ZWave))
		return ZWave.list();

	ZWave.super_.call(this, id, controller);

	this.ZWAY_DEVICE_CHANGE_TYPES = {
		"DeviceAdded": 0x01,
		"DeviceRemoved": 0x02,
		"InstanceAdded": 0x04,
		"InstanceRemoved": 0x08,
		"CommandAdded": 0x10,
		"CommandRemoved": 0x20,
		"ZDDXSaved": 0x100,
		"EnumerateExisting": 0x200
	};

	this.ZWAY_DATA_CHANGE_TYPE = {
		"Updated": 0x01,       // Value updated or child created
		"Invalidated": 0x02,   // Value invalidated
		"Deleted": 0x03,       // Data holder deleted - callback is called last time before being deleted
		"ChildCreated": 0x04,  // New direct child node created

		// ORed flags
		"PhantomUpdate": 0x40, // Data holder updated with same value (only updateTime changed)
		"ChildEvent": 0x80     // Event from child node
	};

	this.CC = {
		"Basic": 0x20,
		"SwitchBinary": 0x25,
		"SwitchMultilevel": 0x26,
		"SwitchColor": 0x33,
		"SceneActivation": 0x2b,
		"Alarm": 0x71,
		"AlarmSensor": 0x9c,
		"SensorBinary": 0x30,
		"SensorMultilevel": 0x31,
		"Meter": 0x32,
		"MeterPulse": 0x35,
		"ThermostatMode": 0x40,
		"ThermostatSetPoint": 0x43,
		"ThermostatFanMode": 0x44,
		"DoorLock": 0x62,
		"CentralScene": 0x5b,
		"Battery": 0x80,
		"DeviceResetLocally": 0x5a,
		"BarrierOperator": 0x66
	};

	this.default_expert_config = {
		'debug' : false
	};

}

// Module inheritance and setup

inherits(ZWave, AutomationModule);

_module = ZWave;

Object.defineProperty(ZWave, "list", {
	value: function () {
		return Object.keys(ZWave);
	},
	enumerable: false,
	writable: false,  
	configurable: false 
});

ws.allowExternalAccess("ZWave.list", controller.auth.ROLE.ADMIN);

ZWave.prototype.updateList = function() {
	this.controller.setNamespace("zways", this.controller.namespaces, ZWave.list().map(function(name) { return {zwayName: name}; }));
};

ZWave.prototype.init = function (config) {
	ZWave.super_.prototype.init.call(this, config);

	var self = this;

	// select the latest updated postfix.json
	this.postfix = this.loadModuleJSON("postfix.json");
	updatedPostfix = loadObject("postfix.json");

	if (!!updatedPostfix && updatedPostfix.last_update && this.postfix.last_update && updatedPostfix.last_update > this.postfix.last_update) {
		this.postfix = updatedPostfix; 
	}

	this.expert_config = loadObject("expertconfig.json");

	if(!!!this.expert_config) {
		this.expert_config = self.default_expert_config;
		saveObject("expertconfig.json", this.expert_config);
	}

	this.cmdClasses = this.loadModuleJSON("cmd_classes.json");

	this.ipacket = [];
	this.opacket = [];
    this.iPacketBuffer = {
        lastUpdate: null,
        packets: []
    };
    this.oPacketBuffer = {
        lastUpdate: null,
        packets: []
    };
    this.originPackets = loadObject('originPackets.json') || {
        incoming: [],
        outgoing: []
    }

	// select custompostfix.json
	custom_postfix = loadObject("custompostfix.json");

    // add custom_postfix to postfix
	if(!!custom_postfix) {
        custom_fixes = custom_postfix.fixes;
        pfixes = this.postfix.fixes;

        for(var x in custom_fixes) {
            var z = 0;
            for(var y in pfixes) {
                if(custom_fixes[x].p_id === pfixes[y].p_id) {
                    custom_fixes[x].id = pfixes[y].id;
                    pfixes[y] = _.assign(pfixes[y], custom_fixes[x]);
                    break;
                }
                z++;
            }

            if(z == pfixes.length) {
                var id = Math.max.apply(Math, pfixes.map(function(fix) {
                    return fix.id;
                }));
                custom_fixes[x].id = (id +1);
                pfixes.push(custom_fixes[x]);
            }
        }

		this.postfix.fixes = pfixes;
	}

	this.startBinding();
	if (!this.zway) {
		return;
	}

	this._dataBind = function(dataBindings, zwayName, nodeId, instanceId, commandClassId, path, func, type) {
		if (zwayName === self.config.name && self.zway) {
			self.dataBind(dataBindings, self.zway, nodeId, instanceId, commandClassId, path, func, type);
		}
	};
	this._dataUnbind = function(dataBindings) {
		self.dataUnbind(dataBindings);
	};
		
	this.controller.on("ZWave.dataBind", this._dataBind);
	this.controller.on("ZWave.dataUnbind", this._dataUnbind);

	this.controller.emit("ZWave.register", this.config.name);
};

ZWave.prototype.startBinding = function () {
	var self = this;

	try {
		this.zway = new ZWaveBinding(this.config.name, this.config.port, {
			configFolder: this.config.config || 'config',
			translationsFolder: this.config.translations || 'translations',
			zddxFolder: this.config.ZDDX || 'ZDDX',
			terminationCallback: function() {
				self.terminating.call(self);
			}
		});
		
		try {
			this.zway.discover();
		} catch (e1) {
			this.zway.stop();
			throw e1;
		}
	} catch(e) {
		var moduleName = this.getName(),
		    langFile = self.controller.loadModuleLang(moduleName);
		
		this.controller.addNotification("critical", langFile.err_binding_start + e.toString(), "z-wave", moduleName);
		this.zway = null;
		return;
	}

	this.fastAccess = false;
	if (!global.zway) {
		// this is the first zway - make fast shortcut
		this.fastAccess = true;
	}

	global.ZWave[this.config.name] = {
		"zway": this.zway,
		"port": this.config.port,
		"fastAccess": this.fastAccess
	};
	this.updateList();

	this.stopped = false;
	
	if (this.config.enableAPI !== false) {
		this.defineHandlers();
	}

	if (this.fastAccess) {
		if (this.config.enableAPI !== false) {
			this.externalAPIAllow();
		}
		global["zway"] = this.zway; // global variable
		global["ZWaveAPI"] = this.ZWaveAPI;
	}
	if (this.config.enableAPI !== false) {
		this.externalAPIAllow(this.config.name);
	}
	_.extend(global["ZWave"][this.config.name], this.ZWaveAPI);

	if (this.config.createVDev !== false) {
		this.deadDetectionStart();
		this.gateDevicesStart();
	}

    this.CommunicationLogger();
};

ZWave.prototype.stop = function () {
	console.log("--- ZWave.stop()");
	ZWave.super_.prototype.stop.call(this);

	this.stopBinding();

	clearInterval(this.timer);

	if (this._dataBind) {
		this.controller.off("ZWave.dataBind", this._dataBind);
	}
	if (this._dataUnbind) {
		this.controller.off("ZWave.dataUnbind", this._dataUnbind);
	}
};

ZWave.prototype.stopBinding = function () {
	this.controller.emit("ZWave.unregister", this.config.name);
	
	if (this.config.createVDev !== false) {
		this.gateDevicesStop();
		this.deadDetectionStop();
	}

	if (this.fastAccess) {
		if (this.config.enableAPI !== false) {
			this.externalAPIRevoke();
		}
		if (global.zway) {
			delete global["zway"];
			delete global["ZWaveAPI"];
		}
	}
	
	if (this.config.enableAPI !== false) {
		this.externalAPIRevoke(this.config.name);
	}
	if (global.ZWave) {
		delete global.ZWave[this.config.name];
		this.updateList();
	}

	this.stopped = true;
	if (this.zway) {
		try {
			this.zway.stop();
		} catch(e) {
			// Z-Way has already gone
		}
		this.zway = null;
	}
};

ZWave.prototype.terminating = function () {
	if (!this.stopped) {
		console.log("Terminating Z-Wave binding");
		this.stopBinding();

		var self = this;
		setTimeout(function() {
			// retry open after 10 seconds
			console.log("Restarting Z-Wave binding");
			self.startBinding();
		}, 10000);
	}
};

ZWave.prototype.CommunicationLogger = function() {

	var self = this,
		zway = this.zway,
        originPackets = this.originPackets,
        iPacketBuffer = this.iPacketBuffer,
        oPacketBuffer = this.oPacketBuffer,
		ipacket = this.ipacket,
		opacket = this.opacket,
        cmdClasses = this.cmdClasses,
        cmdC = cmdClasses.zw_classes.cmd_class,
        nodeid = zway.controller.data.nodeId.value,
        boxTypeIsCIT = false;

	avg = function(arr) { var ret = arr.reduce(function(a, b) { return a + b; }, 0); return ret/arr.length; };
	stddev = function(arr) { var _avg = avg(arr); ret = arr.reduce(function(p, c) { return p + (c-_avg)*(c-_avg); }, 0); return Math.sqrt(ret)/arr.length; };
	uniq = function(arr) { return arr.filter(function(value, index, self) { return self.indexOf(value) === index; }); };
	group = function(arr) { var ret = {}; arr.map(function(x) { if (ret[x]) ret[x]++; else ret[x] = 1; }); return ret; };

	inH = function () {

        console.debug("log incoming");
        var data = this;

        if (!!originPackets) {
            originPackets.incoming.push(data);
        }

        var _data = data;
        data = createIncomingEntry(data);

        if (!_.isEqual(_.omit(ipacket[ipacket.length-1], 'id', 'rssi'), _.omit(data,'rssi'))){
            console.debug("### IN: Not EQUAL ...");

            var ms = (new Date).getMilliseconds().toString();
            ms = ms.length === 1? '00' + ms: (ms.length === 2? '0' + ms : ms );
            var pId = parseInt(data.updateTime.toString() + ms, 10);

            data.id = pId;

			console.debug("######### incoming ID:", data.id);

            iPacketBuffer = packetBuffer(iPacketBuffer, data, 'in');
            //console.debug('####=======>>## iPacketBuffer:', iPacketBuffer.packets);
        } else {
			console.debug("### IN: IS EQUAL!");
        }

        if (ipacket.length >= 50) {

            var _ipacket = loadObject("incomingPacket.json");

            if (_ipacket === null) {
                _ipacket = [];
            }

            _ipacket = _ipacket.concat(ipacket);

            if (_ipacket.length > 100) {
                console.debug('####=======>>## slice _ipacket ...');
				_ipacket = _.filter(_ipacket, function(entry){
					return entry.id > ((new Date()).getTime() - 8640000);
				});
            }

            saveObject("incomingPacket.json", _ipacket);

            ipacket = [];
        }

        if (originPackets.incoming.length % 100 === 0) {

            if (originPackets.incoming.length > 100) {
				console.debug('####=======>>## slice originPackets.incoming ...');
                originPackets.incoming = _.filter(originPackets.incoming, function(inPacket) {
                    return inPacket.updateTime > ((new Date()).getTime() - 8640000);
                })
            }

            saveObject("originPackets.json", originPackets);
        }

	};

	zway.controller.data.incomingPacket.bind(inH);

	outH = function () {

        console.debug("log outgoing");
        var data = this;

        if (!!originPackets) {
            originPackets.outgoing.push(data);
        }

        var _data = data;
        data = createOutgoingEntry(data);

        if (!_.isEqual(_.omit(opacket[opacket.length-1], 'id', 'rssi', 'hops', 'tries', 'speed'), _.omit(data,'rssi', 'hops', 'tries', 'speed'))){
            console.debug("### OUT: Not EQUAL ...");

            var ms = (new Date).getMilliseconds().toString();
            ms = ms.length === 1? '00' + ms: (ms.length === 2? '0' + ms : ms );
            var pId = parseInt(data.updateTime.toString() + ms, 10);

            data.id = pId;

            oPacketBuffer = packetBuffer(oPacketBuffer, data, 'out');
        } else {
            console.debug("### OUT: IS EQUAL!");
        }

        if(opacket.length >= 50) {
            var _opacket = loadObject("outgoingPacket.json");

            if(_opacket === null) {
                _opacket = [];
            }

            _opacket = _opacket.concat(opacket);

            if (_opacket.length > 100) {
                console.debug('####=======>>## slice _opacket ...');
				_opacket = _.filter(_opacket, function(entry){
					return entry.id > ((new Date()).getTime() - 8640000);
				});
            }

            saveObject("outgoingPacket.json", _opacket);

            opacket = [];
        }

        if (originPackets.outgoing.length % 50 === 0) {

            if (originPackets.outgoing.length > 100) {
				console.debug('####=======>>## slice originPackets.outgoing ...');
                originPackets.outgoing = _.filter(originPackets.outgoing, function(outPacket) {
                    return outPacket.updateTime > ((new Date()).getTime() - 8640000);
                })
            }

            saveObject("originPackets.json", originPackets);
        }
	};

	zway.controller.data.outgoingPacket.bind(outH);

    boxTypeIsCIT = checkBoxtype('cit');

    //check if controller version is >= 05.20 or type is cit
    if (boxTypeIsCIT || !has_higher_version('05.20', zway.controller.data.APIVersion.value)) {
        this.timer = setInterval(function() {
            try {
                var data = loadObject("rssidata.json");

                data = self.rssiData(data);

                // remove values older than 24h
                if ( data.length > 1440){
                    var lastDay = now - 86400;
                    data = _.filter(data, function(entry){
                        return entry.time > lastDay;
                    });
                }

                saveObject("rssidata.json", data);
            } catch (e) {
                console.log('Cannot fetch background RSSI. Error:', e.message);
            }

        }, 1000*30);
	}


    // =================== helper functions ========================

    function prepareRSSI(rssiPacket) {
        var rssi = [];

        if(_.isArray(rssiPacket)){
            _.forEach(rssiPacket, function (rssiValue){
                rssi.push(~(rssiValue - 128) + ' dBm'); // transform to two's (Zweierkomplement)
            });
        } else {
            rssi = ~(rssiPacket - 128) + ' dBm';
        }


        return _.isArray(rssiPacket) && rssi.length < 1? '': rssi;
    }

    function prepareValues(packetValue, packetType,encap,paramCnt) {
        var pV = packetValue,
			shift = encap != 'S' && encap != ''? 2 : 0;

		shift = encap === 'I'? 4 : shift;

        if (_.isArray(packetValue)) {
            if (packetType === 'out') {
                if (packetValue.length >= 8) {
                    pV = packetValue.slice(7 + shift, -1);
                } else {
                    pV = packetValue.length >= 6? packetValue.slice(5 + shift, -1): '';
                }
            } else {
				if (encap !== '') {
					pV = packetValue.length >= 5? packetValue.slice(4 + shift) : '';
				} else {
					pV = packetValue.length >= 3? packetValue.slice(2 + shift) : '';
				}
            }

			if (pV.length === 1 && pV[0] === 0 && paramCnt === 0){
				pV = [];
			}
        }

        return pV;
    };

    function packetApplication(packet, packetType) {

		var cmdClassKey = 0,
            cmdKey = 0,
            ret = {},
            findCmdClass = [],
            _cmdClass = {},
			encaps=[
					'0x60.0x0D', // 'I' => Multichannel
					'0x8F.0x01', // 'M' => Multicommand
					'0x98.0x81', // 'S' => Security
					'0x56.0x01'  // 'C' => CRC16
			]
			result= {
                encap: '',
                application: '',
				params: 0
            },
			hexPString = [],
			shift = 0,
			_cmdClassObject = {};

		packet.forEach(function(p, i){
			var hex = decToHex(p, 2, '0x');
			hexPString.push(hex);
		});

		hexPString.forEach(function(p,i){

			if (hexPString[i+1] != undefined) {
				var capString = hexPString[i]+'.'+hexPString[i+1];

				if (encaps.indexOf(capString) > -1) {
					switch(capString) {
						case '0x8F.0x01':
							result.encap = 'M'; // Multi Cmd Encap
							shift = 2; // shift by two to decode CC and CC Cmd
							return;
						case '0x98.0x81':
							result.encap = 'S'; // Security Encap
							return;
						case '0x56.0x01':
							result.encap = 'C'; // CR16Encap
							shift = 2; // shift by two to decode CC and CC Cmd
							return;
						case '0x60.0x0D':
							result.encap = 'I'; // Multi Channel Multi Instance Encap
							shift = 4; // shift by two to decode CC and CC Cmd
							return;
					}
				}
			} else {
				return;
			}
		});

		// shift by two if encap was found
        if (packet.length >= 6 && packetType === 'out') {
            cmdClassKey = hexPString[5 + shift];
            cmdKey = hexPString[6  + shift];
        } else {
            cmdClassKey = hexPString[0 + shift];
            cmdKey = hexPString[1 + shift];
        }

        findCmdClass = _.filter(cmdC, function (cc){
            return cc['_key'] === cmdClassKey;
        });

        if (findCmdClass.length < 1) {
			if (packet.length > 0) {
				result.application = 'NIF';
				return result;
			} else {
				return;
			}
        }

        // get latest version of filtered
		var latestVersion = Math.max.apply(Math,findCmdClass.map(function(cc){return parseInt(cc['_version'], 10);})).toString();

		_cmdClass = _.filter(findCmdClass, function (cc){
			return cc['_version'] === latestVersion;
		});

		if (_cmdClass[0]) {
			_cmdClass = _cmdClass[0];
		} else {
			return;
		}

        if(_.isEmpty(_cmdClass)) {
            return;
        }

        if (_.isArray(_cmdClass.cmd)) {
            ret = _.filter(_cmdClass.cmd, function (cmd){
                return cmd['_key'] === cmdKey;
            });

            ret = ret[0]? ret[0] : ret;
        } else {
            ret = _cmdClass.cmd;
        }


		if(typeof ret === "object" && ret.hasOwnProperty('_help') && (result.encap === '' || (result.encap != 'S' && result.encap != 'M'))) {
			result.application = ret['_help'] || '';
			result.params = ret['param']? Object.keys(ret['param']).length : 0;
		}

		if (_cmdClass['_help'] && _cmdClass['_help'] !== '' && result.application === '' && result.encap === '') {
			result.application = _cmdClass['_help'].substring(14) + ': ' + cmdKey;
			result.params = _cmdClass['param']? Object.keys(ret['param']).length : 0;
		}

        return result;
    }

    function decToHex(decimal, chars, x) {
        var hex = (decimal + Math.pow(16, chars)).toString(16).slice(-chars).toUpperCase();
        return (x || '') + hex;
    };

    function createIncomingEntry(packet) {
        var pA = _.isArray(packet.value)? packetApplication(packet.value, 'in'):'';

		pA = pA? pA : '';

		var obj = {
            type: 'incoming',
            updateTime: packet.updateTime,
            bytes:packet.value,
            src: packet.nodeId && packet.nodeId.value ? packet.nodeId.value : '',
            rssi: packet.RSSI && packet.RSSI.value ? prepareRSSI(packet.RSSI.value) : '',
			encaps: pA !== '' && pA.encap ? pA.encap : '',
            dest: packet.dstNodeId? packet.dstNodeId.value : '',
            application: pA !== '' && pA.application ? pA.application : ''
        };

        obj.value = prepareValues(packet.value, 'in', obj.encaps, obj.params);

        console.debug("######### incoming APPLICATION:", obj.application, " || encap:", obj.encaps,"|| bytes:", packet.value);

        return obj;
    };

    function createOutgoingEntry(packet) {
        var bytes = packet.value;

		(_.isArray(bytes)) ? bytes.unshift(0) : (bytes = '');	// prepend 1 byte

		var pA = bytes !== ''? packetApplication(bytes, 'out') : '';

		pA = pA? pA : '';

        var obj = {
            type: 'outgoing',
            updateTime: packet.updateTime,
            bytes:packet.value,
            src: nodeid,
            speed: packet.speed && packet.speed.value? packet.speed.value : '',
            rssi: packet.returnRSSI && packet.returnRSSI.value? prepareRSSI(packet.returnRSSI.value) : '',
            hops: packet.hops && packet.hops.value? packet.hops.value : '',
			encaps: pA !== '' && pA.encap ? pA.encap : '',
            tries: packet.tries && packet.tries.value? packet.tries.value : '',
            dest: (_.isArray(packet.value)) ? packet.value[3] : '',
			application: pA !== '' && pA.application ? pA.application : ''
        };

		obj.value = prepareValues(bytes, 'out', obj.encaps, obj.params);

        console.debug("######### outgoing APPLICATION:", obj.application, "|| encap:", obj.encaps,"|| bytes:", bytes);

        return obj;
    };

    // handle packet buffer
    function packetBuffer(bufferObject, packetData, packetType) {
        var now = (new Date()).getTime();

        // add to in/outlists
        if (packetType === 'out') {
            opacket.push(packetData);
        } else {
            ipacket.push(packetData);
        }

        bufferObject.packets.push(packetData);
        bufferObject.lastUpdate = now;

        bufferObject.packets = _.filter(bufferObject.packets, function(packet){
            return packet.id > (now - 15000);
        });

        return bufferObject;
    }

    // =====================================================
};

// --------------- Public HTTP API -------------------


ZWave.prototype.externalAPIAllow = function (name) {
	var _name = !!name ? ("ZWave." + name) : "ZWaveAPI";

	ws.allowExternalAccess(_name, this.config.publicAPI ? this.controller.auth.ROLE.ANONYMOUS : this.controller.auth.ROLE.ADMIN);
	ws.allowExternalAccess(_name + ".Run", this.config.publicAPI ? this.controller.auth.ROLE.ANONYMOUS : this.controller.auth.ROLE.ADMIN);
	ws.allowExternalAccess(_name + ".Data", this.config.publicAPI ? this.controller.auth.ROLE.ANONYMOUS : this.controller.auth.ROLE.ADMIN);
	ws.allowExternalAccess(_name + ".InspectQueue", this.config.publicAPI ? this.controller.auth.ROLE.ANONYMOUS : this.controller.auth.ROLE.ADMIN);
	ws.allowExternalAccess(_name + ".Backup", this.config.publicAPI ? this.controller.auth.ROLE.ANONYMOUS : this.controller.auth.ROLE.ADMIN);
	ws.allowExternalAccess(_name + ".Restore", this.config.publicAPI ? this.controller.auth.ROLE.ANONYMOUS : this.controller.auth.ROLE.ADMIN);
	ws.allowExternalAccess(_name + ".CreateZDDX", this.config.publicAPI ? this.controller.auth.ROLE.ANONYMOUS : this.controller.auth.ROLE.ADMIN);
	ws.allowExternalAccess(_name + ".CommunicationStatistics", this.config.publicAPI ? this.controller.auth.ROLE.ANONYMOUS : this.controller.auth.ROLE.ADMIN);
	ws.allowExternalAccess(_name + ".CommunicationHistory", this.config.publicAPI ? this.controller.auth.ROLE.ANONYMOUS : this.controller.auth.ROLE.ADMIN);
	ws.allowExternalAccess(_name + ".Zniffer", this.config.publicAPI ? this.controller.auth.ROLE.ANONYMOUS : this.controller.auth.ROLE.ADMIN);
	ws.allowExternalAccess(_name + ".RSSIGet", this.config.publicAPI ? this.controller.auth.ROLE.ANONYMOUS : this.controller.auth.ROLE.ADMIN);
	ws.allowExternalAccess(_name + ".TestNode", this.config.publicAPI ? this.controller.auth.ROLE.ANONYMOUS : this.controller.auth.ROLE.ADMIN);
	ws.allowExternalAccess(_name + ".FirmwareUpdate", this.config.publicAPI ? this.controller.auth.ROLE.ANONYMOUS : this.controller.auth.ROLE.ADMIN);
	ws.allowExternalAccess(_name + ".ZMELicense", this.config.publicAPI ? this.controller.auth.ROLE.ANONYMOUS : this.controller.auth.ROLE.ADMIN);
	ws.allowExternalAccess(_name + ".ZMEFirmwareUpgrade", this.config.publicAPI ? this.controller.auth.ROLE.ANONYMOUS : this.controller.auth.ROLE.ADMIN);
	ws.allowExternalAccess(_name + ".ZMEBootloaderUpgrade", this.config.publicAPI ? this.controller.auth.ROLE.ANONYMOUS : this.controller.auth.ROLE.ADMIN);
	ws.allowExternalAccess(_name + ".PostfixUpdate", this.config.publicAPI ? this.controller.auth.ROLE.ANONYMOUS : this.controller.auth.ROLE.ADMIN);
	ws.allowExternalAccess(_name + ".Postfix", this.config.publicAPI ? this.controller.auth.ROLE.ANONYMOUS : this.controller.auth.ROLE.ADMIN);
	ws.allowExternalAccess(_name + ".PostfixAdd", this.config.publicAPI ? this.controller.auth.ROLE.ANONYMOUS : this.controller.auth.ROLE.ADMIN);
	ws.allowExternalAccess(_name + ".PostfixGet", this.config.publicAPI ? this.controller.auth.ROLE.ANONYMOUS : this.controller.auth.ROLE.ADMIN);
	ws.allowExternalAccess(_name + ".PostfixRemove", this.config.publicAPI ? this.controller.auth.ROLE.ANONYMOUS : this.controller.auth.ROLE.ADMIN);
	ws.allowExternalAccess(_name + ".ExpertConfigGet", this.config.publicAPI ? this.controller.auth.ROLE.ANONYMOUS : this.controller.auth.ROLE.ADMIN);
	ws.allowExternalAccess(_name + ".ExpertConfigUpdate", this.config.publicAPI ? this.controller.auth.ROLE.ANONYMOUS : this.controller.auth.ROLE.ADMIN);
	ws.allowExternalAccess(_name + ".CallForAllNIF", this.config.publicAPI ? this.controller.auth.ROLE.ANONYMOUS : this.controller.auth.ROLE.ADMIN);
	ws.allowExternalAccess(_name + ".CheckAllLinks", this.config.publicAPI ? this.controller.auth.ROLE.ANONYMOUS : this.controller.auth.ROLE.ADMIN);
	ws.allowExternalAccess(_name + ".ZWaveDeviceInfoGet", this.config.publicAPI ? this.controller.auth.ROLE.ANONYMOUS : this.controller.auth.ROLE.ADMIN);
	ws.allowExternalAccess(_name + ".ZWaveDeviceInfoUpdate", this.config.publicAPI ? this.controller.auth.ROLE.ANONYMOUS : this.controller.auth.ROLE.ADMIN);
    ws.allowExternalAccess(_name + ".sendZWayReport", this.config.publicAPI ? this.controller.auth.ROLE.ANONYMOUS : this.controller.auth.ROLE.ADMIN);
    ws.allowExternalAccess(_name + ".NetworkReorganization", this.config.publicAPI ? this.controller.auth.ROLE.ANONYMOUS : this.controller.auth.ROLE.ADMIN);
    ws.allowExternalAccess(_name + ".GetReorganizationLog", this.config.publicAPI ? this.controller.auth.ROLE.ANONYMOUS : this.controller.auth.ROLE.ADMIN);
	// -- see below -- // ws.allowExternalAccess(_name + ".JSONtoXML", this.config.publicAPI ? this.controller.auth.ROLE.ANONYMOUS : this.controller.auth.ROLE.ADMIN);
};

ZWave.prototype.externalAPIRevoke = function (name) {
	var _name = !!name ? ("ZWave." + name) : "ZWaveAPI";

	ws.revokeExternalAccess(_name);
	ws.revokeExternalAccess(_name + ".Run");
	ws.revokeExternalAccess(_name + ".Data");
	ws.revokeExternalAccess(_name + ".InspectQueue");
	ws.revokeExternalAccess(_name + ".Backup");
	ws.revokeExternalAccess(_name + ".Restore");
	ws.revokeExternalAccess(_name + ".CreateZDDX");
	ws.revokeExternalAccess(_name + ".CommunicationStatistics");
	ws.revokeExternalAccess(_name + ".CommunicationHistory");
	ws.revokeExternalAccess(_name + ".Zniffer");
	ws.revokeExternalAccess(_name + ".RSSIGet");
	ws.revokeExternalAccess(_name + ".TestNode");
	ws.revokeExternalAccess(_name + ".FirmwareUpdate");
	ws.revokeExternalAccess(_name + ".ZMELicense");
	ws.revokeExternalAccess(_name + ".ZMEFirmwareUpgrade");
	ws.revokeExternalAccess(_name + ".ZMEBootloaderUpgrade");
	ws.revokeExternalAccess(_name + ".PostfixUpdate");
	ws.revokeExternalAccess(_name + ".Postfix");
	ws.revokeExternalAccess(_name + ".PostfixAdd");
	ws.revokeExternalAccess(_name + ".PostfixGet");
	ws.revokeExternalAccess(_name + ".PostfixRemove");
	ws.revokeExternalAccess(_name + ".ExpertConfigGet");
	ws.revokeExternalAccess(_name + ".ExpertConfigUpdate");
	ws.revokeExternalAccess(_name + ".CallForAllNIF");
	ws.revokeExternalAccess(_name + ".CheckAllLinks");
	ws.revokeExternalAccess(_name + ".ZWaveDeviceInfoGet");
	ws.revokeExternalAccess(_name + ".ZWaveDeviceInfoUpdate");
    ws.revokeExternalAccess(_name + ".sendZwayReport");
    ws.revokeExternalAccess(_name + ".NetworkReorganization");
    ws.revokeExternalAccess(_name + ".GetReorganizationLog");
	// -- see below -- // ws.revokeExternalAccess(_name + ".JSONtoXML");
};

ZWave.prototype.defineHandlers = function () {
	var zway = this.zway;
	var postfix = this.postfix;
	var expert_config = this.expert_config;
	var self = this;

    var ipacket = this.ipacket;
    var opacket = this.opacket;
    var iPacketBuffer = this.iPacketBuffer;
    var oPacketBuffer = this.oPacketBuffer;

	this.ZWaveAPI = function() {
		return { status: 400, body: "Bad ZWaveAPI request " };
	};

	this.ZWaveAPI.list = function() {
		try {
			var zwayList = ZWave.list() || [];

			/* TODO: search for remote IP adresses
			if (this.config.publicAPI && zwayList.length > 0) {
				_.forEach(zwayList, function(zwayName, index){
					http.request({
						method: "POST",
						url: data.url,
						contentType: "application/json",
						async: true,
						success: function (res) {
							// do nothing
						},
						error: function (res) {
							// remove from list
							zwayList = zwayList.splice(index, 1);
						}
					});
				});
			}
			console.log("zwayList:", JSON.stringify(zwayList));
			*/
			return zwayList;
		} catch (e) {
			return { status: 500, body: e.toString() };
		}
	};

	this.ZWaveAPI.Run = function(url) {
		url = "with(zway) { " + url.substring(1) + " }";
		try {
			var r = eval(url);
			return {
				status: 200,
				headers: {
					"Content-Type": "application/json",
					"Access-Control-Allow-Origin": "*",
					"Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
					"Access-Control-Allow-Headers": "Authorization",
					"Connection": "keep-alive"
				},
				body: r
			};
		} catch (e) {
			return { status: 500, body: e.toString() };
		}
	};

	this.ZWaveAPI.Data = function(url) {
		var timestamp = parseInt(url.substring(1), 10) || 0;
		return {
			status: 200,
			headers: {
				"Content-Type": "application/json",
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
				"Access-Control-Allow-Headers": "Authorization",
				"Connection": "keep-alive"
			},
			body: zway.data(timestamp)
		};
	};

	this.ZWaveAPI.InspectQueue = function(url) {
		return {
			status: 200,
			headers: {
				"Content-Type": "application/json",
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
				"Access-Control-Allow-Headers": "Authorization",
				"Connection": "keep-alive"
			},
			body: zway.InspectQueue()
		};
	};

	this.ZWaveAPI.Backup = function(url, request) {
		var now = new Date();

		// create a timestamp in format yyyy-MM-dd-HH-mm
        var ts = getHRDateformat(now);

		try {

			// do backup
			var data = zway.controller.Backup();

            return {
				status: 200,
				headers: {
					"Content-Type": "application/x-download",
					"Content-Disposition": "attachment; filename=z-way-backup-" + ts + ".zbk",
					"Access-Control-Allow-Origin": "*",
					"Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
					"Access-Control-Allow-Headers": "Authorization",
					"Connection": "keep-alive"
				},
				body: data
			};
		} catch (e) {
			return { status: 500, body: e.toString() };
		}
	};

    this.ZWaveAPI.sendZWayReport = function(url, request) {
        var lines = '',
            q = request.query,
            testLines = function(lines) {
                var l = parseInt(lines,10);
                return l > 0 && l <= 20000 || false;
            },
            logAvailable = fs.stat('lib/fetchLog.sh'),
            report_url = "https://service.z-wave.me/report/index.php",
            ret = false,
        	formElements = [],
			reqObj = request.body? request.body : request.data,
			data;

        reqObj = reqObj && typeof reqObj !== 'string'? reqObj : JSON.parse(reqObj);

        //TODO: Implement for Multiple zways
        /*function createBackup(){
        	var zwayBcp = {}
            // do backup
            global.ZWave.list().forEach(function(zwayName) {
                var bcp = "",
                    data = new Uint8Array(global.ZWave[zwayName].zway.controller.Backup());

                for(var i = 0; i < data.length; i++) {
                    bcp += String.fromCharCode(data[i]);
                }

                zwayBcp[zwayName] = bcp;
            });

        	return zwayBcp;
		}*/

        function createBackup(){
            var zwayBcp = []

			// do backup
			var bcp = "",
				data = new Uint8Array(zway.controller.Backup());

			for(var i = 0; i < data.length; i++) {
				bcp += String.fromCharCode(data[i]);
			}

			zwayBcp = bcp;

            return zwayBcp;
        }

        if (q && logAvailable) {
            lines = q.lines && !_.isNaN(q.lines) && testLines(q.lines)? parseInt(q.lines,10) : lines;
        }

		if (logAvailable) {
			//grep log and add to config/map
			system("sh /opt/z-way-server/automation/lib/fetchLog.sh getLog " + lines);

            data = createBackup();

			//cleanup log's in config/map directory
			system("sh /opt/z-way-server/automation/lib/fetchLog.sh removeLog");
		} else {
            data = createBackup();
		}

		try {
			var now = new Date();
			// create a timestamp in format yyyy-MM-dd-HH-mm
			var ts = getHRDateformat(now);

			// prepare system information
			for (param in reqObj) {
				formElements.push({
					name: param,
					value: reqObj[param].toString()
				})
			}

			if(data) {
				// add backup with log
				formElements.push({
					name: 'log_name',
					value: "report-z-way-backup-log-" + ts + ".tgz"
				},{
                    name: 'log_data',
                    value: Base64.encode(JSON.stringify(data))
				});
			}

			res = formRequest.send(formElements, "POST", report_url);

			if(res.status === -1) { //error e.g. no connection to server
				self.controller.addNotification("error", res.statusText, "module", self.id);
			} else {
				if(res.status === 200) {
					ret = true;
					self.controller.addNotification("info", res.data.message, "module", self.id);
				} else {
					self.controller.addNotification("error", res.data.message, "module", self.id);
				}
			}

		} catch(e) {
			return { status: 500, body: e.toString() }
		}
		return ret;
    };

	this.ZWaveAPI.Restore = function(url, request) {
		if (request.method === "POST" && request.data && request.data && request.data.config_backup) {
			var full = false;
			if (request.query && request.query.hasOwnProperty("restore_chip_info")) {
				var rci = request.query["restore_chip_info"];
				full = (rci === "yes" || rci === "true" || rci === "1");
			}

			var file = request.data.config_backup;
			if (file instanceof Array) {
				file = file[0];
			}
			if (file.name && file.content && file.length > 0) {
				// valid file object detected
				try {
					zway.controller.Restore(file.content, full);
					return {
						status: 200,
						headers: {
							"Content-Type": "application/json",
							"Access-Control-Allow-Origin": "*",
							"Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
							"Access-Control-Allow-Headers": "Authorization",
							"Connection": "keep-alive"
						},
						body: null
					};
				} catch (e) {
					return { status: 500, body: e.toString() };
				}
			}
		}
		return { status: 400, body: "Invalid request" };
	};

	this.ZWaveAPI.CreateZDDX = function(url, request) {
		function hexByteToStr(n) {
			return ("00" + parseInt(n, 10).toString(16)).slice(-2);
		}

		function hexWordToStr(n) {
			return ("0000" + parseInt(n, 10).toString(16)).slice(-4);
		}

		function tagAttrValue(name, value) {
			return	{
				"name": name,
				"attributes": {
					"value": value
				}
			};
		}

		function tagByte(name, value) {
			return tagAttrValue(name, hexByteToStr(value));
		}

		function tagWord(name, value) {
			return tagAttrValue(name, hexWordToStr(value));
		}

		function tagBool(name, value) {
			return tagAttrValue(name, value ? "true": "false");
		}

		function tagText(name, value) {
			return	{
				"name": name,
				"text": value
			};
		}

		function tagLangs(name, values) {
			var
				lang,
				langChildren = [];

			for (lang in values) {
				langChildren.push({
					"name": "lang",
					"attributes": {
						"xml:lang": lang
					},
					"text": values[lang]
				});
			}

			return {
				"name": name,
				"children": langChildren
			};
		}

		function inNIF(id, nif, afterMark) {
			var
				i,
				markFound = false;

			id = parseInt(id, 10);
			for (i in nif) {
				if (nif[i] === 0xEF) {
					markFound = true;
				}

				if (!(afterMark ^ markFound) && parseInt(nif[i], 10) === id) {
					return true;
				}
			}
			return false;
		}

		function tagCC(id, version, supported, secure, nif) {
			return {
				"name": "commandClass",
				"attributes": {
					"id": hexWordToStr(id),
					"version": version,
					"supported": supported || inNIF(id, nif, false),
					"controlled": !supported || inNIF(id, nif, true),
					"secure": secure,
					"inNIF": (supported && inNIF(id, nif, false)) || (!supported && inNIF(id, nif, true))
				}
			};
		}

		var	nodeId = url.split("/")[1],
			d = zway.devices[nodeId],
			zddx = new ZXmlDocument();

		zddx.root = {
			"name": "ZWaveDevice",
			"attributes": {
				"xmlns": "http://www.pepper1.net/zwavedb/xml-schemata/z-wave",
				"schemaVersion": "2"
			},
			"children": [
				{
					"name": "descriptorVersion",
					"text": "1"
				},
				{
					"name": "deviceData",
					"children": [
						tagWord("manufacturerId", d.data.manufacturerId.value),
						tagWord("productType", d.data.manufacturerProductType.value),
						tagWord("productId", d.data.manufacturerProductId.value),
						tagByte("libType", d.data.ZWLib.value),
						tagByte("protoVersion", d.data.ZWProtocolMajor.value),
						tagByte("protoSubVersion", d.data.ZWProtocolMinor.value),
						tagByte("appVersion", d.data.applicationMajor.value),
						tagByte("appSubVersion", d.data.applicationMinor.value),
						tagByte("basicClass", d.data.basicType.value),
						tagByte("genericClass", d.data.genericType.value),
						tagByte("specificClass", d.data.specificType.value),
						tagBool("optional", d.data.optional.value),
						tagBool("listening", d.data.isListening.value),
						tagBool("routing", d.data.isRouting.value),
						tagText("beamSensor", d.data.sensor250.value ? "250" : (d.data.sensor1000.value ? "1000" : "0"))
					]
				},
				{
					"name": "deviceDescription",
					"children": [
						tagLangs("description", {"en": ""}),
						tagLangs("wakeupNote", {"en": ""}),
						tagLangs("inclusionNote", {"en": ""}),
						tagText("productName", ""),
						tagText("brandName", ""),
						tagText("productVersion", d.data.applicationMajor.value.toString()  + "." + d.data.applicationMinor.value.toString())
					]
				},
				{
					"name": "commandClasses",
					"children": (function() {
						var
							ccId, n,
							arr = [],
							ccs = d.instances[0].commandClasses;

						for(ccId in ccs) {
							arr.push(tagCC(ccId, ccs[ccId].data.version.value, ccs[ccId].data.supported.value, ccs[ccId].data.security.value, d.data.nodeInfoFrame.value));
						}
						for(n in d.data.nodeInfoFrame.value) {
							ccId = d.data.nodeInfoFrame.value[n];
							if (!ccs[ccId] && ccId !== 0xEF) {
								arr.push(tagCC(ccId, 1, false, false, d.data.nodeInfoFrame.value));
							}
						}

						return arr;
					})()
				}
			]
		};

		if (d.instances[0].Association) {
			console.logJS(zddx.root.children);
			zddx.root.insertChild({
				"name": "assocGroups",
				"children": (function(data) {
					var
						n,
						Assocs = [];

					for (n = 1; n <= data.groups.value; n++) {
						Assocs.push({
							"name": "assocGroup",
							"attributes": {
								"number": n,
								"maxNodes": data[n].max.value
							},
							"children": [
								tagLangs("description", {"en": "Group " + n.toString()})
							]
						});
					}

					return Assocs;
				})(d.instances[0].Association.data)
			});
			console.logJS(zddx.root.children);
		}

		return {
			"status": 200,
			"body": zddx.toString(),
			"headers": {
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
				"Access-Control-Allow-Headers": "Authorization",
				"Content-Type": "application/xml"
			}
		};
	};

	this.CommunicationStatistics = function (zw) {
		this.MAX_ARRAY_LENGTH = 30;

		this.zw = zw;
		this.zway = null;
		this.communicationStatistics = {};

		this.init(zw);
	}

	this.CommunicationStatistics.prototype.init = function(zw) {
		var self = this;

		if (!zw.zway) {
			return;
		}

		this.zway = zw.zway;
		this.zway.controller.data.outgoingPacket.bind(this.handler, this, false);
	};

	this.CommunicationStatistics.prototype.handler = function(type, self) {
		if (type === self.zw.ZWAY_DATA_CHANGE_TYPE["Deleted"]) return;
		if (!self.communicationStatistics[this.nodeId.value]) {
			self.communicationStatistics[this.nodeId.value] = [];
		}
		self.communicationStatistics[this.nodeId.value].push({
			"date": (new Date()).getTime()/1000,
			"delivered": this.delivered.value,
			"packetLength": this.packetLength.value,
			"deliveryTime": this.deliveryTime.value
		});
		self.communicationStatistics[this.nodeId.value].splice(0, Math.max(self.communicationStatistics[this.nodeId.value].length - self.MAX_ARRAY_LENGTH, 0));
	};

	this.CommunicationStatistics.prototype.stop = function() {
		if (!this.zway) {
			return;
		}

		this.zway.controller.data.outgoingPacket.unbind(this.handler);

		this.communicationStatistics = {};

		this.zway = null;
	};

	this.CommunicationStatistics.prototype.get = function() {
		return this.communicationStatistics;
	};

	this.ZWaveAPI.CommunicationStatistics = (function(that) {
		var cs = new that.CommunicationStatistics(that);
		return function() {
			return cs.get();
		};
	})(this);

	// attach packetlog handler. on Z-Way binding stop it will be released itself, no need to write stop code
	if (zway.controller && zway.controller.data && zway.controller.data.incomingPacket) {
		zway.controller.data.incomingPacket.bind(function() {
			ws.push({
				type: 'me.z-wave.namespaces.z-wave.packetLog',
				data: this.value
			});
		});
	};

	this.ZWaveAPI.CommunicationHistory = function(url, request) {
		var self = this,
            packets = [],
            body = {
                "code": 200,
                "message": "200 OK",
                "updateTime": null,
                "data": []
            },
            _ipacket = loadObject("incomingPacket.json"),
            _opacket = loadObject("outgoingPacket.json"),
            filterObj = null;

		if (request.query && request.query.filter) {
            filterObj = typeof request.query.filter === 'string' ? JSON.parse(request.query.filter) : request.query.filter;
        }

        _ipacket = _.isNull(_ipacket)? ipacket : _ipacket.concat(ipacket);
        _opacket = _.isNull(_opacket)? opacket : _opacket.concat(opacket);

		packets = packets.concat(_opacket, _ipacket);

		if(!_.isEmpty(packets)) {

			body.updateTime = Math.round((new Date()).getTime()/1000);

			if(!_.isNull(filterObj)) {

				if (filterObj.src.value != "") {
					filter = packets.filter(function (p) {
						// filter by array of sources
						var srcs =  filterObj.src.value.split(',');

						if(parseInt(filterObj.src.show) === 1) {
							return srcs.indexOf(p.src.toString()) > -1;
						} else {
							return srcs.indexOf(p.src.toString()) < 0;
						}

					});
					packets = filter;
				}

				if (filterObj.dest.value != "") {
					filter = packets.filter(function (p) {
						// filter by array of destinations
						var dests =  filterObj.dest.value.split(',');

						if(parseInt(filterObj.dest.show) === 1) {
							return dests.indexOf(p.dest.toString()) > -1;
						} else {
							return dests.indexOf(p.dest.toString()) < 0;
						}

					});

					packets = filter;
				}
			}
		}

		body.data = packets;

		return {
			status: 200,
			body: body
		};
	};

    this.ZWaveAPI.Zniffer = function() {
        self = this,
            packets = [],
            body = {
                "code": 200,
                "message": "200 OK",
                "updateTime": null,
                "data": []
            };

        packets = packets.concat(iPacketBuffer.packets, oPacketBuffer.packets);

        packets = _.filter(packets, function(p){
            return p.id > ((new Date()).getTime() - 10000);
        });

        if (packets.length > 0) {

            body.updateTime = Math.round((new Date()).getTime()/1000);

            packets = _.sortBy(packets, function(o) {return o.id});
        }

        body.data = packets;

        return {
            status: 200,
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
                "Access-Control-Allow-Headers": "Authorization",
                "Content-Type": "application/json",
                "Connection": "keep-alive"
            },
            body: body
        };
    }

    this.ZWaveAPI.RSSIGet = function(url, request) {
        var headers = {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
                "Access-Control-Allow-Headers": "Authorization",
                "Content-Type": "application/json",
                "Connection": "keep-alive"
            },
            body = {
                "code": 200,
                "message": "200 OK",
                "updateTime": Math.round((new Date()).getTime() / 1000),
                "data": []
            };

        try {

            var par = url.split("/")[1];

            if (par == "realtime") {

                data = ZWave.prototype.rssiData();

                body.data = data;

            } else {
                body.data = loadObject('rssidata.json');
            }

            if (!!body.data) {

                return {
                    headers: headers,
                    status: 200,
                    body: body
                };
            } else {

                body.code = 404;
                body.message = '404 Not Found';

                return {
                    headers: headers,
                    status: 404,
                    body: body
                };
            }
        } catch (e) {
            return {
                headers: headers,
                status: 500,
                body: "Something went wrong:" + e.toString()
            };
		}
    };
    
        this.ZWaveAPI.TestNode = function(url, request) {
		try {
			var nodeId = url.split("/")[1],
				N = url.split("/")[2] || 10;
			
			var delivered = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
				sent =  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

			var result = "in progress";

			function hasFinished() {
				if (sent.reduce(function(a, b) { return a + b; }, 0) == 10 * N) {
					result = "done";
				}
			}
			
			for (var powerlevel = 0; powerlevel < 10; powerlevel++) {
				(function(pwrlvl) {
					var succesCbk = function() {
						sent[pwrlvl]++;
						delivered[pwrlvl]++;
						hasFinished();
					};
					var failCbk = function() {
						sent[pwrlvl]++;
						hasFinished();
					};

					for (var n = 0; n < N; n++) {
						zway.SendTestFrame(nodeId, pwrlvl, succesCbk, failCbk);
					}
				})(powerlevel)
			}

			var d = (new Date()).valueOf() + 10*N*1000; // wait not more than 10*N seconds
			
			while ((new Date()).valueOf() < d && result === "in progress") {
				processPendingCallbacks();
			}
			
			if (result === "in progress") {
				throw("Timeout");
			}

			return delivered.map(function(val, index) { return 100 * val / sent[index]; });
		} catch (e) {
			return { status: 500, body: e.toString() };
		}
	};
	
	this.ZWaveAPI.FirmwareUpdate = function(url, request) {
		try {
			var deviceId = parseInt(url.substring(1), 10);
			if (!deviceId) {
				throw "Invalid device id";
			}

			var fwUpdate = zway.devices[deviceId].FirmwareUpdate;
			if (!fwUpdate) {
				throw "Device doesn't support FW Update";
			}

			var data = request && request.data;
			if (!data) {
				throw "Invalid request";
			}

			var manufacturerId = fwUpdate.data.manufacturerId.value;
			var firmwareId = fwUpdate.data.firmwareId.value;

			if (!manufacturerId || !firmwareId) {
				throw "Either manufacturer or firmware id is not present";
			}

			if (!fwUpdate.data.upgradeable.value) {
				throw "Firmware is not upgradeable";
			}

			var targetId = parseInt(data.targetId);

			if (data.file && data.file.content) {
				// update firmware from file
				var fw;
				if (data.file.content.substr(0, 1) === ":") {
					// this is a .hex file
					fw = IntelHex2bin(data.file.content);
				} else {
					fw = data.file.content;
				}
				fwUpdate.Perform(manufacturerId, firmwareId, targetId, fw);

                return { status: 200, body: "Initiating update" };
			} else if (data.url) {
				var result = {
                    status: 'in progress'
                };
				var d = (new Date()).valueOf() + 300000; // wait no more than 5 min
				// update firmware from url
				http.request({
					url: data.url,
					headers: {
                        "Access-Control-Allow-Origin": "*",
                        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
                        "Access-Control-Allow-Headers": "Authorization",
                        "Connection": "keep-alive"
					},
					contentType: "application/octet-stream", // enforce binary response,
					async: true,
					success: function (res) {

						console.log('upgrade res:', JSON.stringify(res, null, 1));
						var fw;
						try {
							if (res.data.substr(0, 1) === ":") {
								// this is a .hex file
								fw = IntelHex2bin(res.data);
							} else {
								fw = res.data;
							}
								fwUpdate.Perform(manufacturerId, firmwareId, targetId, fw);

								result.status = 'done';
						} catch (e) {
                            result.error = 'Firmware download successful. Parsing has failed: ' + e.toString();
                            result.status = 'fail';
                            throw ('Firmware download successful. Parsing has failed: ' + e.toString());
						}
					},
					error: function (res) {
                        result.error = 'Failed to download firmware: ' + res.statusText;
                        result.status = 'fail';
                        throw ('Failed to download firmware: ' + res.statusText);
					}
				});

                while ((new Date()).valueOf() < d &&  result.status === "in progress") {
                    processPendingCallbacks();
                }

                result.status = result.status === 'in progress'? 'fail' : result.status;

                if (result.status === 'fail') {
                    return { status: 500, body: result.error };
				} else {
                    return { status: 200, body: "Initiating update" };
				}
			}

		} catch (e) {
			return { status: 500, body: e.toString() };
		}
	};

	this.ZWaveAPI.ZMELicense = function(url, request) {
		try {
			var data = request && request.data;
			if (!data || !data.license) {
				throw "Invalid request";
			}

			var result = "in progress";
			zway.ZMECapabilities(data.license.split(",").map(function(i) { return parseInt(i, 10); }), function() {
				result = "done";
			},  function() {
				result = "failed";
			});
			
			var d = (new Date()).valueOf() + 20000; // wait not more than 20 seconds
			
			while ((new Date()).valueOf() < d &&  result === "in progress") {
				processPendingCallbacks();
			}
			
			if (result === "in progress") {
				result = "failed";
			}
			return (result === "done") ? { status: 200, body: "Done" } : { status: 500, body: "Failed" };
		} catch (e) {
			return { status: 500, body: e.toString() };
		}
	};

	this.ZWaveAPI.ZMEFirmwareUpgrade = function(url, request) {
		try {
			var data = request && request.data;
			if (!data) {
				throw "Invalid request";
			}

			var result = "in progress";

			if (data.file && data.file.content) {
				var buf = new ArrayBuffer(data.file.content.length);
				var bufView = new Uint8Array(buf);
				for (var i = 0; i < data.file.content.length; i++) {
					bufView[i] = data.file.content.charCodeAt(i);
				}

				var L = 32,
				    bootloader_6_70 =
					zway.controller.data.bootloaderCRC.value === 0x8aaa // bootloader for RaZberry 6.70
					||
					zway.controller.data.bootloaderCRC.value === 0x7278 // bootloader for UZB 6.70
				    ,
				    addr = bootloader_6_70 ? 0x20000 : 0x7800, // M25PE10
				    data = bootloader_6_70 ? buf : buf.slice(0x1800);

				for (var i = 0; i < data.byteLength; i += L) {
					var arr = (new Uint8Array(data.slice(i, i+L)));
					if (arr.length == 1) {
						arr = [arr[0]]
						arr.push(0xff); // we only need one byte, but a due to some error single byte is not read
					}
					zway.NVMExtWriteLongBuffer(addr + i, arr);
				}

				zway.NVMExtWriteLongBuffer(addr - 2, [0, 1],  // we only need one byte, but a due to some error single byte is not read
					function() {
						zway.SerialAPISoftReset(function() {
							result = "done";
							zway.stop(); // to force re-start Z-Way
						});
				});
			} else if (data.url) {
				http.request({
					url: data.url,
					async: true,
					contentType: "application/octet-stream",
					success: function(response) {
						var L = 32,
						    bootloader_6_70 =
							zway.controller.data.bootloaderCRC.value === 0x8aaa // bootloader for RaZberry 6.70
							||
							zway.controller.data.bootloaderCRC.value === 0x7278 // bootloader for UZB 6.70
						    ,
						    addr = bootloader_6_70 ? 0x20000 : 0x7800, // M25PE10
						    data = bootloader_6_70 ? response.data : response.data.slice(0x1800);

						for (var i = 0; i < data.byteLength; i += L) {
							var arr = (new Uint8Array(data.slice(i, i+L)));
							if (arr.length == 1) {
								arr = [arr[0]]
								arr.push(0xff); // we only need one byte, but a due to some error single byte is not read
							}
							zway.NVMExtWriteLongBuffer(addr + i, arr);
						}

						zway.NVMExtWriteLongBuffer(addr - 2, [0, 1],  // we only need one byte, but a due to some error single byte is not read
							function() {
								zway.SerialAPISoftReset(function() {
									result = "done";
									zway.stop(); // to force re-start Z-Way
								});
						});
					},
					error: function (res) {
						console.error("Failed to download firmware: " + res.statusText);
						result = "failed";
					}
				});
			} else {
                console.error("Wrong request. Failed to apply firmware.");
                result = "failed";
			}
			
			var d = (new Date()).valueOf() + 300*1000; // wait not more than 5 minutes
			
			while ((new Date()).valueOf() < d &&  result === "in progress") {
				processPendingCallbacks();
			}
			
			if (result === "in progress") {
				result = "failed";
			}
			
			return (result === "done") ? { status: 200, body: "Done" } : { status: 500, body: "Failed" };
		} catch (e) {
			return { status: 500, body: e.toString() };
		}
	};

	this.ZWaveAPI.ZMEBootloaderUpgrade = function(url, request) {
		try {
			var data = request && request.data;
			if (!data) {
				throw "Invalid request";
			}

			var result = "in progress";

			if (data.file && data.file.content) {
				var buf = new ArrayBuffer(data.file.content.length);
				var bufView = new Uint8Array(buf);
				for (var i = 0; i < data.file.content.length; i++) {
					bufView[i] = data.file.content.charCodeAt(i);
				}

				var L = 32,
				    seg = 6,	 // Функция бутлодера принимает номер сегмента
				    addr = seg*0x800, // ==12k
				    data = buf;

				for (var i = 0; i < data.byteLength; i += L) {
					var arr = (new Uint8Array(data.slice(i, i+L)));
					if (arr.length == 1) {
						arr = [arr[0]]
						arr.push(0xff); // we only need one byte, but a due to some error single byte is not read
					}
					zway.NVMExtWriteLongBuffer(addr + i, arr);
				}

				zway.NVMExtWriteLongBuffer(addr - 2, [0, 0],  // we only need one byte, but a due to some error single byte is not read
					function() {
						//Вызываем перезапись bootloder
						zway.ZMEBootloaderFlash(seg, function() {
							result = "done";
							zway.stop(); // to force re-start Z-Way
						},  function() {
							result = "failed";
						});
				});
			} else if (data.url) {
				http.request({
					url: data.url,
					async: true,
					contentType: "application/octet-stream",
					success: function(response) {
						var L = 32,
						    seg = 6,	 // Функция бутлодера принимает номер сегмента
						    addr = seg*0x800, // ==12k
						    data = response.data;

						for (var i = 0; i < data.byteLength; i += L) {
							var arr = (new Uint8Array(data.slice(i, i+L)));
							if (arr.length == 1) {
								arr = [arr[0]]
								arr.push(0xff); // we only need one byte, but a due to some error single byte is not read
							}
							zway.NVMExtWriteLongBuffer(addr + i, arr);
						}

						zway.NVMExtWriteLongBuffer(addr - 2, [0, 0],  // we only need one byte, but a due to some error single byte is not read
							function() {
								//Вызываем перезапись bootloder
								zway.ZMEBootloaderFlash(seg, function() {
									result = "done";
									zway.stop(); // to force re-start Z-Way
								},  function() {
									result = "failed";
								});
						});
					},
					error: function (res) {
						console.error("Failed to download bootloader: " + res.statusText);
						result = "failed";
					}
				});
			} else {
                console.error("Wrong request. Failed to apply bootloader.");
                result = "failed";
            }

			var d = (new Date()).valueOf() + 60*1000; // wait not more than 60 seconds
			
			while ((new Date()).valueOf() < d &&  result === "in progress") {
				processPendingCallbacks();
			}
			
			if (result === "in progress") {
				result = "failed";
			}
			return (result === "done") ? { status: 200, body: "Done" } : { status: 500, body: "Failed" };
		} catch (e) {
			return { status: 500, body: e.toString() };
		}
	};

	this.ZWaveAPI.Postfix = function(url, request) {		
		
		var show = request.query ? request.query : null;

		if (!!postfix) {

			pfix = postfix;

			if (show === 'false') {
				pfix = postfix.fixes? postfix.fixes : postfix;

				pfix = pfix.map(function (fix) { 
						return { p_id: fix.p_id, product: fix.product }
					});
			}
		
			return {
				status: 200,
				headers: {
					"Content-Type": "application/json",
					"Access-Control-Allow-Origin": "*",
					"Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
					"Access-Control-Allow-Headers": "Authorization",
					"Connection": "keep-alive"
				},
				body: pfix
			};
		} else {
			return {
				status: 500,
				body: 'Cannot load postfix.'
			};

		}
	};

	this.ZWaveAPI.PostfixUpdate = function(url, request) {
		var self = this,
			success,
			delay = (new Date()).valueOf() + 10000; // wait not more than 10 seconds

		// update postfix JSON
		http.request({
			url: "http://zwave.dyndns.org:8088/ext_functions/support/dump/postfix.json",
		   	async: true,
			success: function(res) {
				if (res.data && res.data.fixes && res.data.fixes.length > 0 && res.data.last_update && res.data.last_update > postfix.last_update) {
					saveObject('postfix.json', res.data);
					success = 1;
				} else {
					success = 2;
				}
			},
			error: function() {
				console.log('Error has occured during updating the fixes list');
				success = 0;
			}
		});
		
		while (!success && (new Date()).valueOf() < delay) {
			processPendingCallbacks();
		}

		switch(success) {
		   	case 1:
			   	setTimeout(function () {
					self.controller.reinitializeModule('ZWave', 'modules/');
				}, 3000);
					
				return {
					status: 200,
					body: 'ZWave will be reinitialized in 3, 2, 1 ... \nReload the page after 15-20 sec to check if fixes are up to date.'
				};
			case 2: 
				return {
					status: 200,
					body: 'List of fixes is already up to date ... '
				};
			default:
				return {
					status: 500,
					body: 'Something went wrong ... '
				};
		}
	};

	this.ZWaveAPI.PostfixGet = function(url) {
		var p_id = url.substring(1),
			fixes = postfix.fixes,
			fix = fixes.filter(function (fix) {
			return fix.p_id === p_id;
		});

		if (!_.isEmpty(fix)) {
			return {
				status: 200,
				headers: {
					"Content-Type": "application/json",
					"Access-Control-Allow-Origin": "*",
					"Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
					"Access-Control-Allow-Headers": "Authorization",
					"Connection": "keep-alive"
				},
				body: fix[0]
			};
		} else {
			return {status: 404, body: "Postfix with p_id: " + p_id + " not found"};
		}
	};

	this.ZWaveAPI.PostfixAdd = function(url, request) {

		if(request.method === "POST" && request.body) {

			var date = new Date();

			try {
				var reqObj = typeof request.body === "string" ? JSON.parse(request.body) : request.body;
			} catch(e) {
				return { status: 400, body: e.toString() };
			}

            var custom_postfix = loadObject("custompostfix.json");

			if(custom_postfix === null) {

				reqObj.id = 1;

				custom_postfix = {
					"last_update" : Math.floor(date.getTime()/1000),
					"fixes" : [reqObj]
				};

			} else {

				var fixes = custom_postfix.fixes,
					fix = fixes.filter(function(fix) {
						return fix.p_id === reqObj.p_id;
					});

				if(_.isEmpty(fix)) {
					var id = Math.max.apply(Math, custom_postfix.fixes.map(function(fix) {
						return fix.id;
					}));
					reqObj.id = id+1;

					custom_postfix.fixes.push(reqObj);

				} else {

					var tempFixes = fixes;

					for(var p in tempFixes) {
						if(tempFixes[p].p_id === reqObj.p_id) {
							tempFixes[p] = _.assign(tempFixes[p], reqObj);
						}
					}

					custom_postfix.fixes = tempFixes;
				}

				custom_postfix.last_update = Math.floor(date.getTime()/1000);

			}

			saveObject("custompostfix.json", custom_postfix);

			setTimeout(function () {
				self.controller.reinitializeModule('ZWave', 'modules/');
			}, 3000);

			return {
				status: 200,
				body: 'ZWave will be reinitialized in 3, 2, 1 ... \nReload the page after 15-20 sec to check if fixes are up to date.'
			};

		}
		return { status: 400, body: "Invalid request" };
	};

    this.ZWaveAPI.PostfixRemove = function(url, request) {
        if(request.method === "POST" && request.body) {
            var custom_postfix = loadObject("custompostfix.json"),
                reqObj = typeof request.body === "string" ? JSON.parse(request.body) : request.body;

            if(!!custom_postfix) {

                var fixes = custom_postfix.fixes,
                    fix = fixes.filter(function(fix) {
                        return fix.p_id === reqObj.p_id;
                    });

                if(!_.isEmpty(fix)) {
                    fixes = _.reject(fixes ,function(fix) {
                        return fix.p_id === reqObj.p_id;
                    });

                    custom_postfix.fixes = fixes;

                    saveObject("custompostfix.json", custom_postfix);

                    setTimeout(function () {
                        self.controller.reinitializeModule('ZWave', 'modules/');
                    }, 3000);

                    return {
                        status: 200,
                        body: 'Postfix with p_id: ' + reqObj.p_id + ' removed.\nZWave will be reinitialized in 3, 2, 1 ... \nReload the page after 15-20 sec to check if fixes are up to date.'
                    };

                } else {
                    return {
                        status: 404,
                        body: 'Postfix with p_id: ' + reqObj.p_id + ' not found or already deleted'
                    };
                }
            } else {
                return {
                    status: 404,
                    body: 'Custompostfix does not yet exit'
                };
            }
        }
        return { status: 400, body: "Invalid request" };
    };

    this.ZWaveAPI.ExpertConfigGet = function() {
		return {
			status: 200,
			headers: {
				"Content-Type": "application/json",
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
				"Access-Control-Allow-Headers": "Authorization",
				"Connection": "close"
			},
			body: expert_config
		};
	};

	this.ZWaveAPI.ExpertConfigUpdate = function(url, request) {
		var self = this,
			reqObj;

		if (request.method === "POST" && request.body) {
			reqObj = typeof request.body === "string" ? JSON.parse(request.body) : request.body;

			if(Object.keys(reqObj).length = 1) {
				var keys = Object.keys(reqObj);

				//if(expert_config.hasOwnProperty(keys[0])) {
					_.assign(expert_config, reqObj);

					saveObject("expertconfig.json", expert_config);
					return {
						status: 200,
						body: "Done"
					};

				//} else {
				//	return { status: 404, body: "Property " + keys[0] + " not found" };
				//}
			}
			//TODO multiple property update
			/*
			 for( key in keys) {
			 if(expert_config.hasOwnProperty(keys[key])) {
			 expert_config[keys[key]] = reqObj[keys[key]];
			 }
			 }*/
		}
		return { status: 400, body: "Invalid request" };
	};

    this.ZWaveAPI.CallForAllNIF = function(url, request) {
        var req = request && request.body? request.body : request && request.data? request.data : undefined,
            req = req && typeof req === 'string'? JSON.parse(req) : req,
            delay = req && req.delay? req.delay :null,
            timeout = !!delay? parseInt(delay.toString(), 10) * 1000 : 10000,
            timer = null,
            now = (new Date()).valueOf();

        try {
            var devices = Object.keys(zway.devices);
            var ret = {
                result: [],
                runtime: 0
            };
            var dTS = '';

            if(devices.length > 0) {

                // do not send NIF to itself
                devices.forEach(function (nodeId) {
                    var request = "in progress",
                        entry = {
                            nodeId: nodeId,
                            result: "",
                            runtime: 0,
                            isFLiRS: false,
                            hasBattery: false
                        },
                        start = (new Date()).valueOf(),
                        pendingDelay = start + timeout;

                    if (zway.devices[nodeId] && nodeId != zway.controller.data.nodeId.value) {

                        var isListening = zway.devices[nodeId].data.isListening.value;
                        var isFLiRS = !isListening && (zway.devices[nodeId].data.sensor250.value || zway.devices[nodeId].data.sensor1000.value);
                        var hasWakeup = 0x84 in zway.devices[nodeId].instances[0].commandClasses;

                        console.log('Send NIF to node #' + nodeId + ' ...');
                        zway.RequestNodeInformation(
                            nodeId,
                            function() {
                                request = "done";
                                entry.result = request;
                                entry.runtime= ((new Date()).valueOf() - start) /1000;
                                entry.isFLiRS = isFLiRS;
                                entry.hasBattery = hasWakeup;
                            },  function() {
                                request = "failed";
                                entry.result = request;
                                entry.runtime= ((new Date()).valueOf() - start) /1000;
                                entry.isFLiRS = isFLiRS;
                                entry.hasBattery = hasWakeup;
                            });

                        while (request === "in progress" && (new Date()).valueOf() < pendingDelay && !isFLiRS) {
                            processPendingCallbacks();
                        }

                        if (request === "in progress") {
                            entry.result = hasWakeup? "waiting for wakeup" : "failed";
                            entry.runtime= ((new Date()).valueOf() - start) /1000;
                            entry.isFLiRS = isFLiRS;
                            entry.hasBattery = hasWakeup;
                        }

                        ret.result.push(entry);
                    }
                });
            }

            ret.runtime = Math.floor(((new Date()).valueOf() - now)/1000);
            ret.updateTime = Math.floor(((new Date()).valueOf())/1000);

            return { status: 200, body: ret };
        } catch (e) {
            return { status: 500, body: e.toString() }
        }

        return reply;

    };

    this.ZWaveAPI.CheckAllLinks = function(url, request) {
        var req = request && request.body? request.body : request && request.data? request.data : undefined,
            req = req && typeof req === 'string'? JSON.parse(req) : req,
            delay = req && req.delay? req.delay :null,
            timeout = !!delay && parseInt(delay.toString(), 10) >= 1? parseInt(delay.toString(), 10) * 1000 : 2000,
            timer = null,
            nodeId = req && req.nodeId? req.nodeId : null;

        try {
            if(!!nodeId && zway.devices[nodeId] && nodeId != zway.controller.data.nodeId.value) { // do not test against itself
                var neighbours = zway.devices[nodeId].data.neighbours.value;
                var supported = zway.devices[nodeId].instances[0].commandClasses[115]? true : false;
                var ret = {
                	runtime: neighbours.length * (timeout /1000),
                    link_test : 'TestNodeSet',
                    srcNodeId: nodeId,
                    dstNodeIds: neighbours,
					test: []
				};
                if (supported) {
                    neighbours.forEach(function (neighbour) {
                        var start = (new Date()).valueOf();
                        var item = {};
                        var powerLvl = zway.devices[nodeId].instances[0].commandClasses[115];

                        console.log('# Send TestNodeSet from #' + nodeId + ' to #' + neighbour);
                        powerLvl.TestNodeSet(neighbour, 6, 20);

                        // wait 2 sec or more
                        while ((new Date()).valueOf() < (start + timeout)) {
                            processPendingCallbacks();
                        }

                        if (powerLvl.data[neighbour]) {
                            item[neighbour] = {
                                totalFrames: powerLvl.data[neighbour].totalFrames.value,
                                acknowledgedFrames: powerLvl.data[neighbour].acknowledgedFrames.value
                            }
                        }

                        ret.test.push(item);

                    });

                    ret.updateTime = Math.floor(((new Date()).valueOf())/1000);

                    return { status: 200, body: ret };
                } else {
                    return { status: 404, body: 'Not supported for this device.'};
				}

            } else {
                return { status: 404, body: 'Node not found.' };
            }
        } catch (e) {
            return { status: 500, body: e.toString() };
        }

        return reply;
    };

	this.ZWaveAPI.ZWaveDeviceInfoGet = function(url, request) {
        var reply = {
				status: 200,
				headers: {
					"Content-Type": "application/json",
					"Access-Control-Allow-Origin": "*",
					"Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
					"Access-Control-Allow-Headers": "Authorization",
					"Connection": "close"
				},
				body: null
			},
			l = ['en','de'],  //this.controller.availableLang
            devInfo = {},
        	reqObj = !request.query? undefined : (typeof request.query === "string" ? JSON.parse(request.query) : request.query);

		try {

			devID = reqObj && reqObj.id? reqObj.id : null;
			language = reqObj && reqObj.lang && l.indexOf(reqObj.lang) > -1? reqObj.lang : 'en';

			if (reqObj && reqObj.lang && l.indexOf(reqObj.lang) === -1) {
				reply.message = 'Language not found. English is used instead.';
			}

            devInfo = loadObject(language +'.devices.json'); //this.controller.defaultLang


			if (devInfo === null) {
                reply.status = 404;
                reply.message = 'No list of Z-Wave devices found. Please try to download them first.';
			} else {
                reply.body = devInfo;

                if (!!devID) {
                    reply.body = _.find(devInfo.zwave_devices, function(dev) {
                        return dev['Product_Code'] === devID;
                    });

                    if (!reply.body) {
                       reply.status = 404;
                       reply.message = 'No ZWave devices found. Please try to download them first.';
                       reply.body = null;
					}
				}
			}
		} catch (e) {
            reply.status = 500;
            reply.message = 'Something went wrong:' + e.message;
		}

		return reply;
	};

	this.ZWaveAPI.ZWaveDeviceInfoUpdate = function() {
		var self = this,
			result = [],
			l = ['en','de'],  //this.controller.availableLang,
			reply = {
				status: 500,
				headers: {
					"Content-Type": "application/json",
					"Access-Control-Allow-Origin": "*",
					"Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
					"Access-Control-Allow-Headers": "Authorization",
					"Connection": "close"
				},
				body: null
			},
			delay = (new Date()).valueOf() + 10000; // wait not more than 10 seconds

		try {
			// update postfix JSON
			l.forEach(function(lang) {
				var obj = {},
                	blub = {
						updateTime: '',
						zwave_devices: []
					};

				obj[lang] = false;

				http.request({
					url: "http://manuals-backend.z-wave.info/make.php?lang=" + lang + "&mode=ui_devices",
					async: true,
					success: function(res) {
						if (res.data) {
							data = typeof res.data === 'string'? JSON.parse(res.data) : res.data;
                            blub.updateTime = (new Date()).getTime();

							for (index in data) {
                                blub.zwave_devices.push(data[index]);
							}

							saveObject(lang +'.devices.json', blub);
							obj[lang] = true;
						}

						result.push(obj);
					},
					error: function() {
						console.log('ZWave device list for lang:' + lang + ' not found.');
						result.push(obj);
					}
				});
			});

			while (result.length < l.length && (new Date()).valueOf() < delay) {
				processPendingCallbacks();
			}

			if(result) {
				reply.status = 200;
				reply.body = result;
			}

		} catch (e) {
			console.log('Error has occured during updating the ZWave devices list');
			reply.message = 'Something went wrong:' + e.message;
		}

		return reply;
	};

    this.ZWaveAPI.NetworkReorganization = function(url, request) {
        var self = this,
            reply = {
                status: 500,
                headers: {
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
                    "Access-Control-Allow-Headers": "Authorization",
                    "Connection": "close"
                },
                body: null
            },
			// prepare request data
            req = request && request.query? request.query : undefined,
            req = req && typeof req === 'string'? JSON.parse(req) : req,
        	cntNodes = 0,
			requestInterval = 10000, // wait 10 sec between each node reorganization
			// check if all reorganizations of types have finished
			finished = function () {
        		var f = true;
				Object.keys(self.progress).forEach(function(type){
                    f = !self.progress[type] || (self.progress[type] && self.progress[type].pendingCbk.length < 1 );
					if (!f) {
                    	return;
					}
				});
                return f;
			},
            reorgMain, reorgBattery;

        // reorganization log array
        self.reorgLog = [];
		// warpper that includes all node responses
        self.nodeRes = {};
        // object that shows progress of each container
        self.progress = {};
		// outstanding node objects of reorganization interval
        self.nodesPending = [];
		// timeout for reorg interval
        self.reorgIntervalTimeout = (new Date().valueOf() + 1200000); // no more than 20 min
		// load module language keys
        self.langFile = self.controller.loadModuleLang('ZWave');
		// prepare request properties
        reorgMain = req && req.hasOwnProperty('reorgMain')? req.reorgMain == 'true' : true;
        reorgBattery = req && req.hasOwnProperty('reorgBattery')? req.reorgBattery == 'true' : false;

        /*
        * Add a progress container of special type to progress object
        */
        function addTypeToProgress (type, reorg) {
            if(!self.progress[type]) {
                self.progress[type] = {
                    reorg: reorg,
                    status: '',
                    pendingCbk: [],
                    timeout: [],
                    all: [],
                    intervalNodesPending: [],
                    nodesPending: []
                };
            }
		};

		/*
		 * Add a log entry to reorgLog array
		 */
        function addLog (message, nodeId) {
        	var entry = {
        		timestamp: (new Date()).valueOf(),
				message: message,
				node: nodeId? nodeId : undefined,
				type: nodeId && self.nodeRes[nodeId]? self.nodeRes[nodeId].type : undefined,
                status: nodeId && self.nodeRes[nodeId]? self.nodeRes[nodeId].status : undefined,
                tries: nodeId && self.nodeRes[nodeId]? self.nodeRes[nodeId].tries : undefined
			};

        	self.reorgLog.push(entry);

            if (self.reorgLog.length > 0) {
                saveObject('reorgLog', self.reorgLog);
			}
		}

		/*
		 * Remove pending node after done/failed/timeout
		 */
        function removeFromPending (type,nodeId) {
            if (self.progress[type].pendingCbk.indexOf(nodeId) > -1) {
                self.progress[type].pendingCbk = self.progress[type].pendingCbk.filter(function(node) {
                    return	node != nodeId;
                });
            }
        }

		/*
		 * Remove pending node after delayed done/failed callback from timeout list
		 */
        function removeFromTimeout (type,nodeId) {
            if(self.progress[type].timeout.indexOf(nodeId) > -1) {
                self.progress[type].timeout = self.progress[type].timeout.filter(function(node) {
                    return	node != nodeId;
                });
            }
        }

		/*
		 * Trigger reorganization of a node and define their callback functions
		 */
        function doReorg(nodeId, type){

			// add single node status
            if (!self.nodeRes[nodeId]) {
                self.nodeRes[nodeId] = {
                    status: "in progress",
                    type: type,
                    tries: 0,
                    timeout: 0
                };
			}

			/*
			 * success calback function
			 * - set node response
			 * - update routing table
			 * - update pending/timeout arrays
			 */
			var succesCbk = function() {
                var message = '#'+nodeId+' ('+type+') ';

                self.nodeRes[nodeId] = _.extend(self.nodeRes[nodeId],{
					status: 'done',
					type: type,
					tries: self.nodeRes[nodeId].tries
				});

                zway.GetRoutingTableLine(nodeId);

                addLog(message + '... '+self.langFile.reorg +' '+self.langFile.reorg_success, nodeId);

                removeFromPending(type, nodeId);
                removeFromTimeout(type, nodeId);

                i=4;
			};

			/*
			 * fail calback function
			 * - set node response
			 * - trigger reorganization 3 times for failed main devices
			 * - update pending/timeout arrays
			 */
			var failCbk = function() {
				var preMessage = '#'+nodeId+' ('+type+') ',
					message='',
					tries = 0;

				self.nodeRes[nodeId] = _.extend(self.nodeRes[nodeId],{
                    status: 'failed',
                    type: type,
                    tries: self.nodeRes[nodeId].tries + 1
                });

                tries = self.nodeRes[nodeId].tries;

                if (type === 'main' && tries < 3) {
                        addLog(preMessage + '... ' + tries + self.langFile.reorg_try_failed + ' ' + self.langFile.reorg_next_try);
                        reorgUpdate(nodeId);
				} else {
                    message = type === 'main'? self.langFile.reorg_all_tries_failed : '... '+self.langFile.reorg +' '+self.langFile.reorg_failed;

                    addLog(preMessage + message, nodeId);

                    removeFromPending(type, nodeId);
                    removeFromTimeout(type, nodeId);
				}
			};

			/*
			 * Trigger RequestNodeNeighbourUpdate
			 * - set callback timeout of 15 sec
			 * - respond immediately if it fails
			 */
            var reorgUpdate = function (nodeId){
                try {
                    self.nodeRes[nodeId].timeout = (new Date()).valueOf() + 30000; // wait not more than 15 seconds
                    zway.RequestNodeNeighbourUpdate(nodeId, succesCbk, failCbk);
                } catch (e) {
                    console.log(self.langFile.reorg_err_node+nodeId+': ' + e.message);
                    self.nodeRes[nodeId].status = 'failed';
                    removeFromPending(type, nodeId);
                    addLog('#'+nodeId+' ('+self.nodeRes[nodeId].type+') ... '+self.langFile.reorg +' '+self.langFile.reorg_failed, nodeId);
                }
            }

            // initial reorganization request
            reorgUpdate(nodeId);
		}

		/*
		 * reorganize each outstanding node step by step and remove it from list
		 */
		function nodeReorg(){
            var nodeId = self.nodesPending[0].nodeId,
                type = self.nodesPending[0].type,
                currProgressType = self.progress[type],
                all = currProgressType.all,
                intervalNodesPending = currProgressType.intervalNodesPending,
                status = currProgressType.status,
                reorg = currProgressType.reorg,
                key = self.langFile['reorg_all_'+type]? self.langFile['reorg_all_'+type] : self.langFile['reorg_all'] + self.langFile[type] + ': ';

            if(all.length > 0 && all.length === intervalNodesPending.length) {
                addLog(key + JSON.stringify(all));
            } else if (intervalNodesPending.length < 1 && status === 'in progress' && reorg) {
                self.progress[type].status = 'done';
                addLog(self.langFile.reorg_of + self.langFile[type] + ' ' + self.langFile.reorg_complete);
            }

            // do reorg for node
            doReorg(nodeId, type);

            // remove node from intervalNodesPending
            if (self.progress[type].intervalNodesPending.indexOf(nodeId) > -1) {
                self.progress[type].intervalNodesPending = self.progress[type].intervalNodesPending.filter(function(node) {
                    return	node != nodeId;
                });
            }

            // remove first entry from outstanding nodes list
            self.nodesPending = self.nodesPending.filter(function(entry){
                return !_.isEqual(entry,{nodeId:nodeId,type:type})
            });
		};

		var initialMsg = reorgBattery && reorgMain? self.langFile.reorg_with_battery : reorgBattery && !reorgMain? self.langFile.reorg_battery_only : self.langFile.reorg_without_battery;

		// add initial message to reorganization log
		addLog(self.langFile.reorg_started + initialMsg);

		// go through all zway devices and push them in their type specific progress container
		Object.keys(zway.devices).forEach(function(nodeId) {
			var node = zway.devices[nodeId],
                isListening = node.data.isListening.value,
				isMain = (isListening && node.data.isRouting.value) || (isListening && !node.data.isRouting.value),
				isFLiRS = node.data.sensor250.value || node.data.sensor1000.value,
				isBattery = !isListening && (!node.data.sensor250.value || !node.data.sensor1000.value),
				// depending on request params decide if node should be added
				add = (reorgBattery && isBattery && !isFLiRS) || (reorgMain && !isBattery) || (reorgMain && isBattery && isFLiRS)? true: false,
				type = isBattery && !isFLiRS? 'battery': (isFLiRS? 'flirs': 'main');

			if (add){
                addTypeToProgress(type,add);
                self.progress[type].all.push(nodeId);
                // add list of pending nodes for callback
                self.progress[type].pendingCbk = self.progress[type].all;
                // add list of pending nodes for interval
                self.progress[type].intervalNodesPending = self.progress[type].all;
                // add node/type object to type specific list of outstanding nodes - is necessary for interval progress chain
                self.progress[type].nodesPending.push({nodeId: nodeId, type: type});
                cntNodes++;
			}
		});

		// set initial status of progress container
        if (self.progress['main']) {
            self.progress['main'].status = 'in progress';
        } else if (self.progress['battery']) {
            self.progress['battery'].status = 'in progress';
        }

        // merge all lists with node/type objects of outstanding node together
        Object.keys(self.progress).forEach(function(type){
            self.nodesPending = _.uniq(self.nodesPending.concat(self.progress[type].nodesPending));
		});

        // initial reorganization of first node
        if (self.nodesPending[0]) {
            nodeReorg();
        }

        // process interval that starts reorganization of each node after 10 sec
        this.progressInterval = setInterval(function(){
            if (self.nodesPending[0]) {
            	nodeReorg();
            } else {
                clearInterval(self.progressInterval);
                self.progressInterval = null;
                self.nodesPending = [];
			}
        }, requestInterval);

         /*
         * Global reorganization interval that checks for:
		 * - callback timeouts
		 * - whole reorganization progress has timed out
		 * - whole reorganization progress has finished
		 */
        this.reorgInterval = setInterval(function(){
            var nodes = [],
                cntNodes = Object.keys(self.nodeRes).length,
				now = (new Date()).valueOf();

            Object.keys(self.nodeRes).forEach(function(nodeId){
            	var nodeRes = self.nodeRes[nodeId],
					type = nodeRes.type,
					status = nodeRes.status,
					currArr = self.progress[type];

            	if (nodes.indexOf(nodeId) < 0) {

            		if (status !== 'in progress') {
                        nodes.push(nodeId);
                    } else if (status === 'in progress' && nodeRes.timeout < now) {
                        self.nodeRes[nodeId].status = 'timeout';
                        addLog('#'+nodeId+' ('+type+') ... ' +self.langFile.reorg_timeout, nodeId);
                        removeFromPending(type, nodeId);
                        nodes.push(nodeId);
                        currArr.timeout.push(nodeId);
                    } else {
                    	if (currArr.pendingCbk.indexOf(nodeId) < 0) {
                            currArr.pendingCbk.push(nodeId);
						}
					}
				}
			});

            // remove all
            if (self.reorgInterval &&
				(nodes.length >= cntNodes && finished()) ||
				self.reorgIntervalTimeout < now) {

            	var allTimeout = [];

                Object.keys(self.progress).forEach(function (type) {
                    allTimeout = _.uniq(allTimeout.concat(self.progress[type].timeout));
				});

                if (self.reorgIntervalTimeout < now) {
                    addLog(self.langFile.reorg_timeout+' ... '+self.langFile.reorg_canceled);
                    addLog('finished');
                } else {
                	if (allTimeout && allTimeout.length > 0) {
                        addLog(self.langFile.reorg_timeout_nodes + ' '+ JSON.stringify(allTimeout));
					}
                    addLog(self.langFile.reorg+' '+self.langFile.reorg_complete);
                    addLog('finished');
                }

            	clearInterval(self.reorgInterval);
            }
		}, 5000);

		if(self.nodeRes) {
			reply.status = 201;
			reply.body = {
				data: self.langFile.reorg + initialMsg + self.langFile.reorg_starting
			};
		}

        return reply;
    };

    this.ZWaveAPI.GetReorganizationLog = function(url, request) {
        var self = this,
            reply = {
                status: 200,
                headers: {
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
                    "Access-Control-Allow-Headers": "Authorization",
                    "Connection": "close"
                },
                body: null
            }

		reorgLog = loadObject('reorgLog');

		reply.body = !!reorgLog? reorgLog : [];

        return reply;
    }
	/*
	// -- not used -- //
	this.ZWaveAPI.JSONtoXML = function(url, request) {
		function hexByteToStr(n) {
			return ("00" + parseInt(n).toString(16)).slice(-2);
		}

		function hexWordToStr(n) {
			return ("0000" + parseInt(n).toString(16)).slice(-4);
		}

		function nic(name, id) {
			return {
				"name": name,
				"attributes": {
					"id": id,
				},
				"children": []
			};
		}

		function tagDH(name, invalidateTime, updateTime, type, value) {
			switch (type) {
				case "int[]":
				case "float[]":
				case "binary":
					value = "[" + value.toString() + "]";
					break;
				case "string[]":
					value = "[" + value.map(function(el) { return "&quot;" + el + "&quot;"; }).toString() + "]"
					break;
			}

			return {
				"name": "data",
				"attributes": {
					"name": name,
					"invalidateTime": invalidateTime,
					"updateTime": updateTime,
					"type": type,
					"value": value
				},
				"children": []
			};
		}

		function treeDH(name, data) {
			var tag = tagDH(name, data.invalidateTime, data.updateTime, data.type, data.value);
			for (var key in data) {
				if (["value", "type", "invalidateTime", "updateTime"].indexOf(key) != -1)
					continue;
				tag.children.push(treeDH(key, data[key]));
			}
			return tag;
		}

		z = fs.loadJSON(url.split("/")[1]);
		var x = new ZXmlDocument();

		x.root = {
			"name": "devicesData",
			"children": []
		};

		x.root.insertChild({
			"name": "controller",
			"children": []
		});

		x.root.insertChild(treeDH("controller.data", z.controller.data));

		for (var nodeId in z.devices) {
			var device = nic("device", nodeId);
			device.children.push(treeDH("devices." + nodeId + ".data", z.devices[nodeId].data));
			for (var instanceId in z.devices[nodeId].instances) {
				var instance = nic("instance", instanceId);
				instance.children.push(treeDH("devices." + nodeId + ".insances." + instanceId + ".data", z.devices[nodeId].instances[instanceId].data));
				for (var ccId in z.devices[nodeId].instances[instanceId].commandClasses) {
					var cc = nic("commandClass", hexWordToStr(ccId));
					cc.children.push(treeDH("devices." + nodeId + ".insances." + instanceId + ".commandClasses." + ccId + ".data", z.devices[nodeId].instances[instanceId].commandClasses[ccId].data));
					instance.children.push(cc);
				}
				device.children.push(instance);
			}
			x.root.insertChild(device);
		}

		return {
			"status": 200,
			"body": x.toString(),
			"headers": {
				"Content-Type": "application/xml",
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
				"Access-Control-Allow-Headers": "Authorization",
			}
		};
	};
	*/
};


// ------------- Data Binding --------------

ZWave.prototype._dataBind = function(dataBindings, zwayName, nodeId, instanceId, commandClassId, path, func, type) {
		if (zwayName === this.config.name) {
			this.dataBind(dataBindings, this.zway, nodeId, instanceId, commandClassId, path, func, type);
		}
	}
ZWave.prototype.dataBind = function(dataBindings, zway, nodeId, instanceId, commandClassId, path, func, type) {
	// three prototypes:
	//  (dataBindings, zway, nodeId, instanceId, commandClassId, path, func, type)
	//  (dataBindings, zway, nodeId,                             path, func)
	//  (dataBindings, zway,                                     path, func) // bind to controller data

	var pathArr = [],
		data = null,
		ctrlBind = is_function(instanceId),
		devBind = is_function(commandClassId);

	if (ctrlBind) {
		path = nodeId;
		func = instanceId;
		nodeId = undefined;
		instanceId = undefined;
		commandClassId = undefined;
		data = zway.controller.data;
	} else if (devBind) {
		path = instanceId;
		func = commandClassId;
		instanceId = undefined;
		commandClassId = undefined;
		data = zway.devices[nodeId].data;
	} else {
		data = zway.devices[nodeId].instances[instanceId].commandClasses[commandClassId].data;
	}

	if (path) {
		pathArr = path.split(".");
	}

	if (!func) {
		console.log("Function passed to dataBind is undefined");
		return;
	}

	while (pathArr.length) {
		data = data[pathArr.shift()];
		if (!data) {
			break;
		}
	}

	if (data) {
		if (ctrlBind) {
			dataBindings.push({
				"zway": zway,
				"path": path,
				"func": data.bind(func, false)
			});
		} else if (devBind) {
			dataBindings.push({
				"zway": zway,
				"nodeId": nodeId,
				"path": path,
				"func": data.bind(func, nodeId, false)
			});
		} else {
			dataBindings.push({
				"zway": zway,
				"nodeId": nodeId,
				"instanceId": instanceId,
				"commandClassId": commandClassId,
				"path": path,
				"func": data.bind(func, null, type === "child")
			});
			if (type === "value") {
				func.call(data, this.ZWAY_DATA_CHANGE_TYPE.Updated);
			}
		}
	} else {
	 	console.log("Can not find data path:", nodeId, instanceId, commandClassId, path);
	}
};

ZWave.prototype.dataUnbind = function(dataBindings) {
	dataBindings.forEach(function (item) {
		var ctrlBind = ! ("nodeId" in item),
		    devBind = ! ("instanceId" in item);

		if (item.zway && item.zway.isRunning() && (ctrlBind || (item.zway.devices[item.nodeId] && (devBind || (item.zway.devices[item.nodeId].instances[item.instanceId] && item.zway.devices[item.nodeId].instances[item.instanceId].commandClasses[item.commandClassId]))))) {
			var data = ctrlBind ? item.zway.controller.data : (devBind ? item.zway.devices[item.nodeId].data : item.zway.devices[item.nodeId].instances[item.instanceId].commandClasses[item.commandClassId].data),
				pathArr = item.path ? item.path.split(".") : [];

			while (pathArr.length) {
				data = data[pathArr.shift()];
				if (!data) {
					break;
				}
			}

			if (data) {
				data.unbind(item.func);
			} else {
				console.log("Can not find data path:", item.nodeId, item.instanceId, item.commandClassId, item.path);
			}
		}
	});
	dataBindings = null;
};


// ------------- Dead Detection ------------


ZWave.prototype.deadDetectionStart = function () {
	var self = this;

	this.deadDetectionDataBindings = [];

	// Bind to all future CommandClasses changes
	this.deadDetectionBinding = this.zway.bind(function (type, nodeId) {
		if (type === self.ZWAY_DEVICE_CHANGE_TYPES["DeviceAdded"]) {
			self.deadDetectionAttach(nodeId);
		}
	}, this.ZWAY_DEVICE_CHANGE_TYPES["DeviceAdded"] | this.ZWAY_DEVICE_CHANGE_TYPES["EnumerateExisting"]);
};

ZWave.prototype.deadDetectionStop = function () {
	// releasing bindings
	try {
		if (this.deadDetectionDataBindings) {
			this.dataUnbind(this.deadDetectionDataBindings);
		}
	} catch(e) {
		// Z-Way already gone, skip deallocation
		//this.zway = null;
	}
};

ZWave.prototype.deadDetectionAttach = function(nodeId) {
	var self = this;
	this.dataBind(this.deadDetectionDataBindings, this.zway, nodeId, "isFailed", function(type, arg) {
		if (type === self.ZWAY_DATA_CHANGE_TYPE["Deleted"]) return;
		if (!(type & self.ZWAY_DATA_CHANGE_TYPE["PhantomUpdate"])) {
			self.deadDetectionCheckDevice(self, arg);
		}
	});
	this.dataBind(this.deadDetectionDataBindings, this.zway, nodeId, "failureCount", function(type, arg) {
		if (type === self.ZWAY_DATA_CHANGE_TYPE["Deleted"]) return;
		if (!(type & self.ZWAY_DATA_CHANGE_TYPE["PhantomUpdate"])) {
			self.deadDetectionCheckDevice(self, arg);
		}
	});
};

ZWave.prototype.deadDetectionCheckDevice = function (self, nodeId) {
	var values = nodeId.toString(10),
	    moduleName = this.getName(),
	    langFile = this.controller.loadModuleLang(moduleName);

	if (self.zway.devices[nodeId].data.isFailed.value) {
		if (self.zway.devices[nodeId].data.failureCount.value === 2) {
			self.controller.addNotification("error", langFile.err_connct + values, "connection", moduleName);
		}
	} else {
		self.controller.addNotification("notification", langFile.dev_btl + values, "connection", moduleName);
	}
};


// ----------------- Devices Creator ---------------


ZWave.prototype.gateDevicesStart = function () {

	var self = this,
		fixesDone = [];

	this.gateDataBinding = [];

	// Bind to all future CommandClasses changes
	this.gateBinding = this.zway.bind(function (type, nodeId, instanceId, commandClassId) {
		if (type === self.ZWAY_DEVICE_CHANGE_TYPES["CommandAdded"]) {
			// Ignore Static PC Controllers
			if (2 === self.zway.devices[nodeId].data.basicType.value && 1 === self.zway.devices[nodeId].data.specificType.value) {
				// console.log("Device", nodeId, "is a Static PC Controller, ignoring");
				return;
			}

			self.dataBind(self.gateDataBinding, self.zway, nodeId, instanceId, commandClassId, "interviewDone", function(type) {
				if (this.value === true && type !== self.ZWAY_DATA_CHANGE_TYPE["Deleted"]) {

					var create = true,
						changeVDev = {},
						deviceData = self.zway.devices[nodeId].data,
						deviceInstances = self.zway.devices[nodeId].instances,
						deviceCC = deviceInstances[instanceId].commandClasses[commandClassId],
						c = self.zway.controller,
						mId = deviceData.manufacturerId.value? deviceData.manufacturerId.value : null,
						mPT = deviceData.manufacturerProductType.value? deviceData.manufacturerProductType.value : null,
						mPId = deviceData.manufacturerProductId.value? deviceData.manufacturerProductId.value: null,
						appMajor = deviceData.applicationMajor.value? deviceData.applicationMajor.value: null,
						appMinor = deviceData.applicationMinor.value? deviceData.applicationMinor.value: null,
						devId,
						postFix,
						fixes = self.postfix.fixes? self.postfix.fixes : self.postfix;					
					
					// try to get fix by manufacturerProductId and application Version
					if (!!mId && !!mPT && !!mPId && !!self.postfix) {

						devId = mId + '.' + mPT + '.' + mPId,
						appMajorId = devId + '.' + appMajor,
						appMajorMinorId = devId + '.' + appMajor + '.' + appMinor,
						postFix = fixes.filter(function(fix) {
							return 	fix.p_id === devId || 		//search by manufacturerProductId
									fix.p_id === appMajorId || //search by applicationMajor
									fix.p_id === appMajorMinorId; 	//search by applicationMajor and applicationMinor
						});
					}

					// ----------------------------------------------------------------------------
					// --- postfix functions
					// ----------------------------------------------------------------------------
					
					// add SwitchController support by entering (runs once after inclusion):
					// instId ... instance ID
					// commandClass ... Command Class ID
					// maxBtnNr ... maximum number of widgets that should / could be rendered
					// type ... 'S' for 'scene' and 'B' for 'button' or 'switchControl'
					function sceneSupport (instId, commandClass, maxBtnNr, type) {
						var trapArray = [],
							commandClass = commandClass || null;
						
						trapArray = self.controller.instances.filter(function (instance) {
								return instance.moduleId === 'SwitchControlGenerator';
							});
						if (instId === instanceId && commandClassId === commandClass && deviceCC && c.data.lastIncludedDevice.value === nodeId) {
							maxBtnNr = (deviceCC.data.maxScenes.value && deviceCC.data.maxScenes.value <= maxBtnNr? deviceCC.data.maxScenes.value : maxBtnNr) || 0
							
							if (trapArray[0].params.generated.indexOf('ZWayVDev_zway_Remote_' + nodeId + '-' + instanceId + '-0-1') === -1) {
								for (i = 1; i <= maxBtnNr; i++) {
									this.controller.emit('SwitchControlGenerator.register', self.config.name, nodeId, instanceId, '0', i, type);

									// console output
									console.log('#######################', 'ADD SWITCHCONTROLGENERATOR SUPPORT TO #'+ nodeId,'###############################');
									console.log('###');
									console.log('###', 'Add support for instance ' + instId + ':');
									console.log('###', 'CC:', commandClass);
									console.log('###', 'Set maximum number of buttons / secnes to :', maxBtnNr);
									console.log('###', 'Add virtual devices as type button (B) or scene (S):', type);
									console.log('###');
									console.log('############################################################################################################');
								}
							}
						}
					}

					// set device config by entering (runs once after inclusion):
					// instId ... instance ID
					// parameter ... id of the parameter that should be changed
					// value ... new value
					// size ... 0 for auto or 1, 2, 4 (Byte)
					function setConfig (instId, parameter, value, size) {
						var parameter = parseInt(parameter) || null,
							value = parseInt(value) || null,
							size = parseInt(size) || null;

						if(instId === instanceId && !!parameter && !!value && !!size){
							// set config after inclusion only and if it doesn't exist or isn't equal
							if(commandClassId === 112 && deviceCC && c.data.lastIncludedDevice.value === nodeId && (!deviceCC.data[parameter] || (deviceCC.data[parameter] && deviceCC.data[parameter].val.value !== value))){
								deviceCC.Set(parameter, value, size);

								// console output
								console.log('#######################', 'CHANGE CONFIGURATION OF #'+ nodeId,'###############################');
								console.log('###');
								console.log('###', 'Change configuration of instance ' + instId + ':');
								console.log('###', 'parameter:', parameter);
								console.log('###', 'value:', value);
								console.log('###', 'size:', size);
								console.log('###');
								console.log('###############################################################################################');
							}
						}
					}

					// change CC entries by entering (runs once after inclusion):
					// instId ... instance ID
					// commandClass ... Command Class ID
					// dataType ... data type object that should be changed -e.g. security, version, interviewDone
					// key ... of this data type object
					// value ... new value
					function setCCData (instId, commandClass, dataType, key, value) {
						var commandClass = parseInt(commandClass, 10);

						if (commandClassId === commandClass && 
								deviceInstances[instId].commandClasses[commandClass] 
									&& c.data.lastIncludedDevice.value === nodeId){ 
													
							// set value
							if (typeof value !== 'undefined' &&
									deviceInstances[instId].commandClasses[commandClass].data[dataType] &&
										deviceInstances[instId].commandClasses[commandClass].data[dataType][key] &&
											deviceInstances[instId].commandClasses[commandClass].data[dataType][key] !== value) {
								
								deviceInstances[instId].commandClasses[commandClass].data[dataType][key] = value;

								// console output
								console.log('#######################', 'SET COMMANDCLASS DATA OF:', devId,'################################');
								console.log('###');
								console.log('###', 'Change CC entry of instance ' + instId + ':');
								console.log('###', 'CC:', commandClass);
								console.log('###', 'data type object that has changed:', dataType);
								console.log('###', 'new value for ' + key +':', value);
								console.log('###');
								console.log('##############################################################################################');
							}
						}
					}

					// change the node name (runs once after inclusion):
					function renameNode(nodeName) {

						if (nodeName !== deviceData.givenName.value) {

							// do something
							deviceData.givenName.value = nodeName && nodeName !== '' && !!nodeName? nodeName : deviceData.givenName.value;

							// console output
							console.log('#######################', 'Apply postfix #'+ nodeId,'################################');
							console.log('###');
							console.log('###', 'Change node name to: ', nodeName);
							console.log('###');
							console.log('######################################################################################');
						}
					}

					// ----------------------------------------------------------------------------
					// --- END
					// ----------------------------------------------------------------------------

					if (postFix) {
						if (postFix.length > 0) {
							try {
								// works of course only during inclusion - after restart hidden elements are visible again
								if (!!nodeId && c.data.lastIncludedDevice.value === nodeId) {
									var intDone = deviceCC.data.interviewDone.value;
									    intDelay = (new Date()).valueOf() + 5*1000; // wait not more than 5 seconds for single interview

									// wait till interview is done
									while ((new Date()).valueOf() < intDelay &&  intDone === false) {
										intDone = deviceCC.data.interviewDone.value;
									}
									
									if (intDone === false) {
										try {
											// call preInteview functions from postfix.json
											postFix.forEach(function(fix){
												if (!!fix.preInterview && fix.preInterview && fix.preInterview.length > 0) {
													fix.preInterview.forEach(function(func){
														eval(func);
													});
												}
											});
										} catch(e) {
											// console output
											console.log('##############', 'INTERVIEW-HAS-FAILED-----PREFIX-HAS-FAILED:', '#' + nodeId,'#######################');
											console.log('###');
											console.log('###', 'ERROR:', e.toString());
											console.log('###');
											console.log('######################################################################################################');
										}
									}
								}
								
								// call postInterview functions from postfix.json
								postFix.forEach(function(fix) {
									if(!!fix.postInterview && fix.postInterview && fix.postInterview.length > 0) {
										fix.postInterview.forEach(function(entry) {
											var splittedEntry = entry.split(','),
												devICC = instanceId + '-' + commandClassId;

											if (splittedEntry.length > 0) {

												switch (splittedEntry[0]) {
													case 'rename':
													case 'hide':
													case 'deactivate':
													case 'icon':
														if (splittedEntry[1] && splittedEntry[1].indexOf(devICC) > -1 && c.data.lastIncludedDevice.value === nodeId) {
															//add devId
															var nId = nodeId + '-' + splittedEntry[1];

															if (!changeVDev[nId]) {
																changeVDev[nId] = {};
															}

															// devId (instId-CC-sCC-eT) / postFix type / value - fallback true for hide / deactivate
															changeVDev[nId][splittedEntry[0]] = splittedEntry[2] ? splittedEntry[2] : true;
														}

														break;
													case 'discreteState':
														if (splittedEntry[1] && splittedEntry[1].indexOf(devICC) > -1 && c.data.lastIncludedDevice.value === nodeId) {
															//add devId
															var nId = nodeId + '-' + splittedEntry[1];

															if (!changeVDev[nId]) {
																changeVDev[nId] = {};
															}

															if (!changeVDev[nId]['discreteState']) {
																changeVDev[nId]['discreteState'] = {};
															}

															// devId (instId-CC-sCC-eT) / postFix type / scene + keyAttribute / value - fallback undefined
															changeVDev[nId]['discreteState'][splittedEntry[2]] = {
																cnt: splittedEntry[3] ? splittedEntry[3] : undefined,
																action: splittedEntry[4] ? splittedEntry[4] : undefined,
																type: splittedEntry[5] ? splittedEntry[5] : undefined
															};
															//console.log('discreteState',splittedEntry[3]);
															//console.log('changeVDev',JSON.stringify(changeVDev, null, 4));
														}

														break;
													case 'noVDev':

														if (splittedEntry[1] && splittedEntry[1].indexOf(devICC) > -1) {

															var nId = nodeId + '-' + splittedEntry[1];

															//add devId
															//add devId
															if (!changeVDev[nId]) {
																changeVDev[nId] = {};
															}

															// devId (instId-CC-sCC-eT) without creation
															changeVDev[nId].noVDev = true;
														}

														break;
													case 'renameNode':
														if (splittedEntry[1] && c.data.lastIncludedDevice.value === nodeId) {
															renameNode(splittedEntry[1]);
														}

														break;
													default:
														eval(entry);
												}
											}
										});
									}
								});
							} catch(e) {
								// console output
								console.log('#######################', 'PRE-OR-POSTFIX-ERROR:', '#' + nodeId,'################################');
								console.log('###');
								console.log('###', 'ERROR:', e.toString());
								console.log('###');
								console.log('#################################################################################################');
							}
						}
					}

					var ccId = nodeId + '-' + instanceId + '-' + commandClassId;

					if (!changeVDev[ccId] || (changeVDev[ccId] && !changeVDev[ccId].noVDev)) {
						self.parseAddCommandClass(nodeId, instanceId, commandClassId, false, changeVDev);
					} else if (changeVDev[ccId] && changeVDev[ccId].noVDev) {
						var devId = "ZWayVDev_" + self.config.name + "_" + nodeId + '-' + ccId;
						// console output
						console.log('#######################', 'Apply postfix for:', devId,'################################');
						console.log('###');
						console.log('###', 'not created');
						console.log('###');
						console.log('########################################################################################');
					}
				} else {
					self.parseDelCommandClass(nodeId, instanceId, commandClassId, false);
				}
			}, "value");
		} else {
			self.parseDelCommandClass(nodeId, instanceId, commandClassId);
		}
	}, this.ZWAY_DEVICE_CHANGE_TYPES["CommandAdded"] | this.ZWAY_DEVICE_CHANGE_TYPES["CommandRemoved"] | this.ZWAY_DEVICE_CHANGE_TYPES["EnumerateExisting"]);

	self.dataBind(self.gateDataBinding, self.zway, "lastExcludedDevice", function(type) {
		var _id = this.value,
		    _toRemove = self.controller.devices.filter(function (el) { return el.id.indexOf("ZWayVDev_" + self.config.name + "_" + _id + '-') === 0; }).map(function(el) { return el.id; });

		_toRemove.forEach(function (name) {
			self.controller.devices.remove(name);
			self.controller.devices.cleanup(name);
		});
	}, "");	
};

ZWave.prototype.gateDevicesStop = function () {
	var self = this;
	
	// delete devices
	this.controller.devices.map(function (el) {
		return el.id;
	}).filter(function(el) {
		return el.indexOf("ZWayVDev_" + self.config.name + "_") === 0;
	}).forEach(function(el) {
		self.controller.devices.remove(el);
	});
	
	// releasing bindings
	try {
		if (this.gateDataBinding) {
			this.dataUnbind(this.gateDataBinding);
		}
		if (this.zway) {
			this.zway.unbind(this.gateBinding);
		}
	} catch(e) {
		// Z-Way already gone, skip deallocation
		//this.zway = null;
	}
};

ZWave.prototype.parseAddCommandClass = function (nodeId, instanceId, commandClassId, scaleAdded, changeVDev) {
	nodeId = parseInt(nodeId, 10);
	instanceId = parseInt(instanceId, 10);
	commandClassId = parseInt(commandClassId, 10);

	var self = this,
		instance = this.zway.devices[nodeId].instances[instanceId],
		instanceCommandClasses = Object.keys(instance.commandClasses).map(function(x) { return parseInt(x); }),
		cc = instance.commandClasses[commandClassId],
		separ = "-",
		vDevIdPrefix = "ZWayVDev_" + this.config.name + "_",
		vDevIdNI = nodeId + separ + instanceId,
		vDevIdC = commandClassId,
		vDevId = vDevIdPrefix + vDevIdNI + separ + vDevIdC,
		changeDevId = vDevIdNI + separ + vDevIdC,
		defaults;
		// vDev is not in this scope, but in {} scope for each type of device to allow reuse it without closures

	try {
		if (!cc.data.supported.value) {
			return; // do not handle unsupported Command Classes
		}

		/*
		// Ignore SwitchBinary if SwitchMultilevel exists
		if (this.CC["SwitchBinary"] === commandClassId && in_array(instanceCommandClasses, this.CC["SwitchMultilevel"]) && instance.commandClasses[this.CC["SwitchMultilevel"]].data.supported.value) {
			// console.log("Ignoring SwitchBinary due to SwitchMultilevel existence");
			return;
		}
		if (this.CC["SwitchMultilevel"] === commandClassId && this.controller.devices.get(vDevIdPrefix + vDevIdNI + separ + this.CC["SwitchBinary"])) {
			// console.log("Removing SwitchBinary due to SwitchMultilevel existence");
			this.controller.devices.remove(vDevIdPrefix + vDevIdNI + separ + this.CC["SwitchBinary"]);
		}
		*/

		var vendorName = "";
		if (this.zway.devices[nodeId].data.vendorString.value) {
			vendorName = this.zway.devices[nodeId].data.vendorString.value;
		}

		function compileTitle() {
			var args = [],
				sortArgs = [],
				last = 0,
				addVendor = true,
				lastId = '',
				lastIdArr = [];

			for (var i = 0; i < arguments.length; i++) {
				args.push(arguments[i]);
			}

			last = args.length - 1

			if (args[last] === false) {
				addVendor = false;
				// move by one position to id
				last = args.length - 2;
			}

			// add vendorName on first position
			if (vendorName && addVendor) {
				sortArgs.push(vendorName);
			}

			// add probeType on second position if available
			if(last > 1 && args[1]) {
				sortArgs.push(args[1]);
			}

			// add CC type if array is still empty
			if (sortArgs.length < 1) {
				sortArgs.push(args[0]);
			}

			// add CC type
			if (sortArgs.indexOf(args[0]) < 0 && args[0] !== 'Sensor') {
				sortArgs.push(args[0]);
			}

			// add id
			lastIdArr = args[last].split('-');

			// devices[nodeId].instances[0].commandClasses[96]
			if (self.zway.devices[lastIdArr[0]].instances[0].commandClasses[96] && Object.keys(self.zway.devices[lastIdArr[0]].instances).length > 1) {
				lastId = '(' + args[last].replace(/-/g, '.') + ')';
			} else {
				lastId = '(#' + lastIdArr[0] + ')';
			}

			/*if (args[last].indexOf('-0') > -1 ) {
				lastId = args[last].split('-').shift();
			} else {
				lastId = '(' + args[last].replace(/-/g, '.') + ')';
			}*/

			sortArgs.push(lastId);
			
			return sortArgs.join(' ');
		}

		function postfixLog(devId, changeObj) {

            // console output
            console.log('#######################', 'Apply postfix for:', devId,'################################');
            console.log('###');

			try {
				if (changeObj.noVDev) {
					console.log('###', 'not created');
				} else {
					Object.keys(changeObj).forEach(function (key) {
						console.log('###', 'change ' + key + ' into:', changeObj[key]);
					});
				}
			} catch (e) {
				console.log('Error in postfix log:', e.toString());
			}

            console.log('###');
            console.log('########################################################################################');
		}

		function applyPostfix(defaultObj, changeObj, devId, devIdNI) {
			defaultObj.metrics.icon = changeObj.icon? changeObj.icon : defaultObj.metrics.icon;
			defaultObj.metrics.title = changeObj.rename? compileTitle(changeObj.rename, devIdNI, false) : defaultObj.metrics.title;
			defaultObj.visibility = changeObj.hide? false : true;
			defaultObj.permanently_hidden = changeObj.deactivate? true : false;

			if (defaultObj.metrics.discreteStates) {
				defaultObj.metrics.discreteStates = changeObj.discreteState && !_.isEmpty(changeObj.discreteState)? changeObj.discreteState : defaultObj.metrics.discreteStates;
			}

			postfixLog(devId, changeObj);

			return defaultObj;
		}

		if (this.CC["SwitchBinary"] === commandClassId && !self.controller.devices.get(vDevId)) {

			defaults = {
				deviceType: "switchBinary",
				metrics: {
					icon: 'switch',
					title: compileTitle('Switch', vDevIdNI)
				}
			};

			// apply postfix if available
			if (changeVDev[changeDevId]) {
				defaults = applyPostfix(defaults, changeVDev[changeDevId], vDevId, vDevIdNI);
			}

			var vDev = self.controller.devices.create({
				deviceId: vDevId,
				defaults: defaults,
				overlay: {},
				handler: function (command) {
					if ("on" === command) {
						cc.Set(true);
					} else if ("off" === command) {
						cc.Set(false);
					} else if ("update" === command) {
						cc.Get(vDevId);
					}
				},
				moduleId: self.id
			});

			if (vDev) {
				self.dataBind(self.gateDataBinding, self.zway, nodeId, instanceId, commandClassId, "level", function (type) {
					try {
						if (!(type & self.ZWAY_DATA_CHANGE_TYPE["Invalidated"])) {
							vDev.set("metrics:level", this.value ? "on" : "off");
						}
					} catch (e) {}
				}, "value");
			}
		} else if (this.CC["SwitchMultilevel"] === commandClassId && !self.controller.devices.get(vDevId)) {
			var isMotor = this.zway.devices[nodeId].data.genericType.value === 0x11 && _.contains([0x03, 0x05, 0x06, 0x07], this.zway.devices[nodeId].data.specificType.value);
			defaults = {
				deviceType: "switchMultilevel",
				probeType: isMotor ? 'motor' : 'multilevel',
				metrics: {
					icon: isMotor ? 'blinds' : 'multilevel',
					title: compileTitle(isMotor ? 'Blind' : 'Dimmer', vDevIdNI)
				}
			};

			// apply postfix if available
			if (changeVDev[changeDevId]) {
				defaults = applyPostfix(defaults, changeVDev[changeDevId], vDevId, vDevIdNI);
			}


			var vDev = self.controller.devices.create({
				deviceId: vDevId,
				defaults: defaults,
				overlay: {},
				handler: function(command, args) {
					var newVal = this.get('metrics:level');
					// up, down for Blinds
					if ("on" === command || "up" === command) {
						newVal = 255;
					} else if ("off" === command || "down" === command) {
						newVal = 0;
					} else if ("min" === command) {
						newVal = 10;
					} else if ("max" === command || "upMax" === command) {
						newVal = 99;
					} else if ("increase" === command) {
						newVal = newVal + 10;
						if (0 !== newVal % 10) {
							newVal = Math.round(newVal / 10) * 10;
						}
						if (newVal > 99) {
							newVal = 99;
						}

					} else if ("decrease" === command) {
						newVal = newVal - 10;
						if (newVal < 0) {
							newVal = 0;
						}
						if (0 !== newVal % 10) {
							newVal = Math.round(newVal / 10) * 10;
						}
					} else if ("exact" === command || "exactSmooth" === command) {
						newVal = parseInt(args.level, 10);
						if (newVal < 0) {
							newVal = 0;
						} else if (newVal === 255) {
							newVal = 255;
						} else if (newVal > 99) {
							if (newVal === 100) {
								newVal = 99;
							} else {
								newVal = null;
							}
						}
					} else if ("stop" === command) { // Commands for Blinds
						cc.StopLevelChange();
						return;
					} else if ("startUp" === command) {
						cc.StartLevelChange(0);
						return;
					} else if ("startDown" === command) {
						cc.StartLevelChange(1);
						return;
					} else if ("update" === command) {
						cc.Get(vDevId);
						return;
					}

					if (0 === newVal || !!newVal) {
						if ("exactSmooth" === command)
							cc.Set(newVal, args.duration);
						else
							cc.Set(newVal);
					}
				},
				moduleId: self.id
			});

			if (vDev) {
				self.dataBind(self.gateDataBinding, self.zway, nodeId, instanceId, commandClassId, "level", function(type) {
					try {
						if (!(type & self.ZWAY_DATA_CHANGE_TYPE["Invalidated"])) {
							vDev.set("metrics:level", this.value);
						}
					} catch (e) {}
				}, "value");
			}
		} else if (this.CC["SwitchColor"] === commandClassId && !self.controller.devices.get(vDevId)) {
			var
				COLOR_SOFT_WHITE = 0,
				COLOR_COLD_WHITE = 1,
				COLOR_RED = 2,
				COLOR_GREEN = 3,
				COLOR_BLUE = 4;

			var haveRGB = cc.data && cc.data[COLOR_RED] && cc.data[COLOR_GREEN] && cc.data[COLOR_BLUE] && true;
			
			if (haveRGB && !self.controller.devices.get(vDevId + separ + "rgb")) {

				var defaults =  {
					deviceType: "switchRGBW",
					probeType: 'switchColor_rgb',
					metrics: {
						icon: 'multilevel',
						title: compileTitle('Color', vDevIdNI),
						color: {r: cc.data[COLOR_RED].level.value, g: cc.data[COLOR_GREEN].level.value, b: cc.data[COLOR_BLUE].level.value},
						level: 'off'
					}
				}

				// apply postfix if available
				if (changeVDev[changeDevId]) {
					defaults = applyPostfix(defaults, changeVDev[changeDevId], vDevId + separ + "rgb", vDevIdNI);
				}

				var vDev_rgb = this.controller.devices.create({
					deviceId: vDevId + separ + "rgb",
					defaults: defaults,
					overlay: {},
					handler:  function (command, args) {
						var color = {r: 0, g: 0, b: 0};
						if (command === "on") {
							color.r = color.g = color.b = 255;
						} else if (command === "off") {
							color.r = color.g = color.b = 0;
						} else if (command === "exact") {
							color.r = parseInt(args.red, 10);
							color.g = parseInt(args.green, 10);
							color.b = parseInt(args.blue, 10);
						}
						cc.SetMultiple([COLOR_RED, COLOR_GREEN, COLOR_BLUE], [color.r, color.g, color.b]);
					},
					moduleId: this.id
				});

				function handleColor(type, arg) {
					if (type === self.ZWAY_DATA_CHANGE_TYPE.Deleted) {
						self.controller.devices.remove(vDevId + separ + 'rgb');
					} else {
						vDev_rgb.set("metrics:color", {r: cc.data[COLOR_RED].level.value, g: cc.data[COLOR_GREEN].level.value, b: cc.data[COLOR_BLUE].level.value});
					}
					
					vDev_rgb.set("metrics:level", (cc.data[COLOR_RED].level.value || cc.data[COLOR_GREEN].level.value || cc.data[COLOR_BLUE].level.value) ? "on" : "off");
				}
					
				if (vDev_rgb) {
					self.dataBind(self.gateDataBinding, self.zway, nodeId, instanceId, commandClassId, COLOR_RED + ".level", handleColor, "value");
					self.dataBind(self.gateDataBinding, self.zway, nodeId, instanceId, commandClassId, COLOR_GREEN + ".level", handleColor, "value");
					self.dataBind(self.gateDataBinding, self.zway, nodeId, instanceId, commandClassId, COLOR_BLUE + ".level", handleColor, "value");
				}
			}

			Object.keys(cc.data).forEach(function (colorId) {

				colorId = parseInt(colorId, 10);
				if (!isNaN(colorId) && !self.controller.devices.get(vDevId + separ + colorId) && (!haveRGB || (colorId !== COLOR_RED && colorId !== COLOR_GREEN && colorId !== COLOR_BLUE))) {
					var cVDId = changeDevId + separ + colorId;

					// check if it should be created
					if (!changeVDev[cVDId] || changeVDev[cVDId] && !changeVDev[cVDId].noVDev) {
             			defaults = {
							deviceType: "switchMultilevel",
							probeType: '',
							metrics: {
								icon: 'multilevel',
								title: compileTitle(cc.data[colorId].capabilityString.value, vDevIdNI),
								level: 'off'
							}
						}

						// apply postfix if available
						if (changeVDev[cVDId]) {
							defaults = applyPostfix(defaults, changeVDev[cVDId], vDevId + separ + colorId, vDevIdNI);
						}

						switch(colorId) {
							case 0:
								defaults.probeType = 'switchColor_soft_white';
								break;
							case 1:
								defaults.probeType = 'switchColor_cold_white';
								break;
							case 2:
								defaults.probeType = 'switchColor_red';
								break;
							case 3:
								defaults.probeType = 'switchColor_green';
								break;
							case 4:
								defaults.probeType = 'switchColor_blue';
								break;
						}

						var vDev = self.controller.devices.create({
							deviceId: vDevId + separ + colorId,
							defaults: defaults,
							overlay: {},
							handler: function(command, args) {
								var newVal;
								// up, down for Blinds
								if ("on" === command || "up" === command) {
									newVal = 255;
								} else if ("off" === command || "down" === command) {
									newVal = 0;
								} else if ("min" === command) {
									newVal = 10;
								} else if ("max" === command || "upMax" === command) {
									newVal = 99;
								} else if ("increase" === command) {
									newVal = this.metrics.level + 10;
									if (0 !== newVal % 10) {
										newVal = Math.round(newVal / 10) * 10;
									}
									if (newVal > 99) {
										newVal = 99;
									}

								} else if ("decrease" === command) {
									newVal = this.metrics.level - 10;
									if (newVal < 0) {
										newVal = 0;
									}
									if (0 !== newVal % 10) {
										newVal = Math.round(newVal / 10) * 10;
									}
								} else if ("exact" === command || "exactSmooth" === command) {
									newVal = parseInt(args.level, 10);
									if (newVal < 0) {
										newVal = 0;
									} else if (newVal === 255) {
										newVal = 255;
									} else if (newVal > 99) {
										if (newVal === 100) {
											newVal = 99;
										} else {
											newVal = null;
										}
									}
								} else if ("stop" === command) { // Commands for Blinds
									cc.StopLevelChange(colorId);
								} else if ("startUp" === command) {
									cc.StartLevelChange(colorId, 0);
								} else if ("startDown" === command) {
									cc.StartLevelChange(colorId, 1);
								}

								if (0 === newVal || !!newVal) {
									if ("exactSmooth" === command)
										cc.Set(colorId, newVal, args.duration);
									else
										cc.Set(colorId, newVal);
								}
							},
							moduleId: self.id
						});

						if (vDev) {
							self.dataBind(self.gateDataBinding, self.zway, nodeId, instanceId, commandClassId, colorId + ".level", function(type) {
								if (type === self.ZWAY_DATA_CHANGE_TYPE.Deleted) {
									self.controller.devices.remove(vDevId + separ + colorId);
								} else {
									try {
										if (!(type & self.ZWAY_DATA_CHANGE_TYPE["Invalidated"])) {
											vDev.set("metrics:level", this.value);
										}	
									} catch (e) {}
								}
							}, "value");
						}
					}
				}
			});
		} else if (this.CC["SensorBinary"] === commandClassId) {
			defaults = {
				deviceType: 'sensorBinary',
				probeType: '',
				metrics: {
					probeTitle: '',
					scaleTitle: '',
					icon: '',
					level: '',
					title: ''
				}
			};
			Object.keys(cc.data).forEach(function (sensorTypeId) {
				sensorTypeId = parseInt(sensorTypeId, 10);
				if (!isNaN(sensorTypeId) && !self.controller.devices.get(vDevId + separ + sensorTypeId)) {

					var cVDId = changeDevId + separ + sensorTypeId;
					// check if it should be created
					if (!changeVDev[cVDId] || changeVDev[cVDId] && !changeVDev[cVDId].noVDev) {

						defaults.metrics.probeTitle = cc.data[sensorTypeId].sensorTypeString.value;
						defaults.metrics.title = compileTitle('Sensor', defaults.metrics.probeTitle, vDevIdNI);
						// aivs // Motion icon for Sensor Binary by default
						defaults.metrics.icon = "motion";
						defaults.probeType = "general_purpose";

						if (sensorTypeId === 2) {
							defaults.metrics.icon = "smoke";
							defaults.probeType = defaults.metrics.icon;
						} else if (sensorTypeId === 3 || sensorTypeId === 4) {
							defaults.metrics.icon = "co";
							defaults.probeType = defaults.metrics.icon;
						} else if (sensorTypeId === 6) {
							defaults.metrics.icon = "flood";
							defaults.probeType = defaults.metrics.icon;
						} else if (sensorTypeId === 7) {
							defaults.metrics.icon = "cooling";
							defaults.probeType = defaults.metrics.icon;
						} else if (sensorTypeId === 8) {
							defaults.metrics.icon = "tamper";
							defaults.probeType = defaults.metrics.icon;
						} else if (sensorTypeId === 10) {
							defaults.metrics.icon = "door";
							defaults.probeType = "door-window";
						} else if (sensorTypeId === 12) {
							defaults.metrics.icon = "motion";
							defaults.probeType = defaults.metrics.icon;
						}

						// apply postfix if available
						if (changeVDev[cVDId]) {
							defaults = applyPostfix(defaults, changeVDev[cVDId], vDevId + separ + sensorTypeId, vDevIdNI);
						}

						var vDev = self.controller.devices.create({
							deviceId: vDevId + separ + sensorTypeId,
							defaults: defaults,
							overlay: {},
							handler: function (command) {
								if (command === "update") {
									cc.Get(sensorTypeId);
								}
							},
							moduleId: self.id
						});

						if (vDev) {
							self.dataBind(self.gateDataBinding, self.zway, nodeId, instanceId, commandClassId, sensorTypeId + ".level", function (type) {
								if (type === self.ZWAY_DATA_CHANGE_TYPE.Deleted) {
									self.controller.devices.remove(vDevId + separ + sensorTypeId);
								} else {
									try {
										if (!(type & self.ZWAY_DATA_CHANGE_TYPE["Invalidated"])) {
											vDev.set("metrics:level", this.value ? "on" : "off");
										}
									} catch (e) {
									}
									;
								}
							}, "value");
						}
					}
				}
			});
			if (!scaleAdded) {
				self.dataBind(self.gateDataBinding, self.zway, nodeId, instanceId, commandClassId, "", function(type) {
					if (type !== self.ZWAY_DATA_CHANGE_TYPE.Deleted) {
						self.parseAddCommandClass(nodeId, instanceId, commandClassId, true, changeVDev);
					}
				}, "child");
			}
		} else if (this.CC["SensorMultilevel"] === commandClassId) {
			defaults = {
				deviceType: "sensorMultilevel",
				probeType: '',
				metrics: {
					probeTitle: '',
					scaleTitle: '',
					level: '',
					icon: '',
					title: ''
				}
			};
			Object.keys(cc.data).forEach(function (sensorTypeId) {

				sensorTypeId = parseInt(sensorTypeId, 10);
				if (!isNaN(sensorTypeId) && !self.controller.devices.get(vDevId + separ + sensorTypeId)) {

					var cVDId = changeDevId + separ + sensorTypeId;

					// check if it should be created
					if (!changeVDev[cVDId] || changeVDev[cVDId] && !changeVDev[cVDId].noVDev) {

						defaults.metrics.probeTitle = cc.data[sensorTypeId].sensorTypeString.value;
						defaults.metrics.scaleTitle = cc.data[sensorTypeId].scaleString.value;
						defaults.metrics.title = compileTitle('Sensor', defaults.metrics.probeTitle, vDevIdNI);
						if (sensorTypeId === 1) {
							defaults.metrics.icon = "temperature";
							defaults.probeType = defaults.metrics.icon;
						} else if (sensorTypeId === 3) {
							defaults.metrics.icon = "luminosity";
							defaults.probeType = defaults.metrics.icon;
						} else if (sensorTypeId === 4 || sensorTypeId === 15 || sensorTypeId === 16) {
							defaults.metrics.icon = "energy";
							defaults.probeType = defaults.metrics.icon;
						} else if (sensorTypeId === 5) {
							defaults.metrics.icon = "humidity";
							defaults.probeType = defaults.metrics.icon;
						} else if (sensorTypeId === 9) {
							defaults.metrics.icon = "barometer";
							defaults.probeType = defaults.metrics.icon;
						} else if (sensorTypeId === 25) {
							defaults.metrics.icon = "seismic";
							defaults.probeType = defaults.metrics.icon;
						} else if (sensorTypeId === 27) {
							defaults.metrics.icon = "ultraviolet";
							defaults.probeType = defaults.metrics.icon;
						} else if (sensorTypeId === 52) {
							defaults.metrics.icon = "acceleration_x";
							defaults.probeType = defaults.metrics.icon;
						} else if (sensorTypeId === 53) {
							defaults.metrics.icon = "acceleration_y";
							defaults.probeType = defaults.metrics.icon;
						} else if (sensorTypeId === 54) {
							defaults.metrics.icon = "acceleration_z";
							defaults.probeType = defaults.metrics.icon;
						}

						// apply postfix if available
						if (changeVDev[cVDId]) {
							defaults = applyPostfix(defaults, changeVDev[cVDId], vDevId + separ + sensorTypeId, vDevIdNI);
						}

						var vDev = self.controller.devices.create({
							deviceId: vDevId + separ + sensorTypeId,
							defaults: defaults,
							overlay: {},
							handler: function (command) {
								if (command === "update") {
									cc.Get(sensorTypeId);
								}
							},
							moduleId: self.id
						});

						if (vDev) {
							self.dataBind(self.gateDataBinding, self.zway, nodeId, instanceId, commandClassId, sensorTypeId + ".val", function (type) {
								if (type === self.ZWAY_DATA_CHANGE_TYPE.Deleted) {
									self.controller.devices.remove(vDevId + separ + sensorTypeId);
								} else {
									try {
										if (!(type & self.ZWAY_DATA_CHANGE_TYPE["Invalidated"])) {
											vDev.set("metrics:level", this.value);
										}
									} catch (e) {
									}
								}
							}, "value");
						}
					}
				}
			});
			if (!scaleAdded) {
				self.dataBind(self.gateDataBinding, self.zway, nodeId, instanceId, commandClassId, "", function(type) {
					if (type !== self.ZWAY_DATA_CHANGE_TYPE.Deleted) {
						self.parseAddCommandClass(nodeId, instanceId, commandClassId, true, changeVDev);
					}
				}, "child");
			}
		} else if (this.CC["Meter"] === commandClassId) {
			defaults = {
				deviceType: 'sensorMultilevel',
				probeType: '',
				metrics: {
					probeTitle: '',
					scaleTitle: '',
					level: '',
					icon: 'meter',
					title: ''
				}
			};

			Object.keys(cc.data).forEach(function (scaleId) {

				scaleId = parseInt(scaleId, 10);
				if (!isNaN(scaleId) && !self.controller.devices.get(vDevId + separ + scaleId)) {
					var cVDId = changeDevId + separ + scaleId;
					// check if it should be created
					if (!changeVDev[cVDId] || changeVDev[cVDId] && !changeVDev[cVDId].noVDev) {
						defaults.metrics.probeTitle = cc.data[scaleId].sensorTypeString.value;
						defaults.metrics.scaleTitle = cc.data[scaleId].scaleString.value;
						defaults.metrics.title = compileTitle('Meter', defaults.metrics.probeTitle, vDevIdNI);

						// Check sensor type, can be: Electric, Gas, Water
						switch (cc.data[scaleId].sensorType.value) {
							// Electric meter
							case 1:
								switch (scaleId) {
									case 0:
										defaults.probeType = 'meterElectric_kilowatt_hour';
										break;
									case 1:
										defaults.probeType = 'meterElectric_kilovolt_ampere_hour';
										break;
									case 2:
										defaults.probeType = 'meterElectric_watt';
										break;
									case 3:
										defaults.probeType = 'meterElectric_pulse_count';
										break;
									case 4:
										defaults.probeType = 'meterElectric_voltage';
										break;
									case 5:
										defaults.probeType = 'meterElectric_ampere';
										break;
									case 6:
										defaults.probeType = 'meterElectric_power_factor';
										break;
									default:
										break;
								}
								break;
							// Gas meter
							case 2:
								switch (scaleId) {
									case 0:
										defaults.probeType = 'meterGas_cubic_meters';
										break;
									case 1:
										defaults.probeType = 'meterGas_cubic_feet';
										break;
									case 3:
										defaults.probeType = 'meterGas_pulse_count';
										break;
									default:
										break;
								}
								break;
							// Water meter
							case 3:
								switch (scaleId) {
									case 0:
										defaults.probeType = 'meterWater_cubic_meters';
										break;
									case 1:
										defaults.probeType = 'meterWater_cubic_feet';
										break;
									case 2:
										defaults.probeType = 'meterWater_us_gallons';
										break;
									case 3:
										defaults.probeType = 'meterWater_pulse_count';
										break;
									default:
										break;
								}
								break;
							default:
								break;
						}

						// apply postfix if available
						if (changeVDev[cVDId]) {
							defaults = applyPostfix(defaults, changeVDev[cVDId], vDevId + separ + scaleId, vDevIdNI);
						}

						var vDev = self.controller.devices.create({
							deviceId: vDevId + separ + scaleId,
							defaults: defaults,
							overlay: {},
							handler: function (command) {
								if (command === "update") {
									cc.Get(scaleId);
								}
							},
							moduleId: self.id
						});

						if (vDev) {
							self.dataBind(self.gateDataBinding, self.zway, nodeId, instanceId, commandClassId, scaleId + ".val", function (type) {
								if (type === self.ZWAY_DATA_CHANGE_TYPE.Deleted) {
									self.controller.devices.remove(vDevId + separ + scaleId);
								} else {
									try {
										if (!(type & self.ZWAY_DATA_CHANGE_TYPE["Invalidated"])) {
											vDev.set("metrics:level", this.value);
										}
									} catch (e) {
									}
								}
							}, "value");
						}
					}
				}
			});
			if (!scaleAdded) {
				self.dataBind(self.gateDataBinding, self.zway, nodeId, instanceId, commandClassId, "", function(type) {
					if (type !== self.ZWAY_DATA_CHANGE_TYPE.Deleted) {
						self.parseAddCommandClass(nodeId, instanceId, commandClassId, true, changeVDev);
					}
				}, "child");
			}
		} else if (this.CC["MeterPulse"] === commandClassId) {
			defaults = {
				deviceType: 'sensorMultilevel',
				probeType: '',
				metrics: {
					probeTitle: 'meterElectric_pulse_count',
					scaleTitle: '',
					level: '',
					icon: 'meter',
					title: compileTitle('Meter', 'Pulse', vDevIdNI)
				}
			};

			if (!self.controller.devices.get(vDevId)) {
				var cVDId = changeDevId;
				// check if it should be created
				if (!changeVDev[cVDId] || changeVDev[cVDId] && !changeVDev[cVDId].noVDev) {
					// apply postfix if available
					if (changeVDev[cVDId]) {
						defaults = applyPostfix(defaults, changeVDev[cVDId], vDevId, vDevIdNI);
					}

					var vDev = self.controller.devices.create({
						deviceId: vDevId,
						defaults: defaults,
						overlay: {},
						handler: function (command) {
							if (command === "update") {
								cc.Get();
							}
						},
						moduleId: self.id
					});

					if (vDev) {
						self.dataBind(self.gateDataBinding, self.zway, nodeId, instanceId, commandClassId, "val", function (type) {
							if (type === self.ZWAY_DATA_CHANGE_TYPE.Deleted) {
								self.controller.devices.remove(vDevId);
							} else {
								try {
									if (!(type & self.ZWAY_DATA_CHANGE_TYPE["Invalidated"])) {
										vDev.set("metrics:level", this.value);
									}
								} catch (e) {
								}
							}
						}, "value");
					}
				}
			}
		} else if (this.CC["Battery"] === commandClassId && !self.controller.devices.get(vDevId)) {

			defaults = {
				deviceType: 'battery',
				metrics: {
					probeTitle: 'Battery',
					scaleTitle: '%',
					level: '',
					icon: 'battery',
					title: compileTitle('Battery', vDevIdNI)
				}
			};

			// apply postfix if available
			if (changeVDev[changeDevId]) {
				defaults = applyPostfix(defaults, changeVDev[changeDevId], vDevId, vDevIdNI);
			}

			var vDev = self.controller.devices.create({
				deviceId: vDevId,
				defaults: defaults,
				overlay: {},
				handler: function(command) {
					if (command === "update") {
						cc.Get();
					}
				},
				moduleId: self.id
			});

			if (vDev) {
				self.dataBind(self.gateDataBinding, self.zway, nodeId, instanceId, commandClassId, "last", function(type) {
					try {
						if (!(type & self.ZWAY_DATA_CHANGE_TYPE["Invalidated"])) {
							vDev.set("metrics:level", this.value === 255 ? 0 : this.value);
						}
					} catch (e) {}
				}, "value");
			}
		} else if (this.CC["DoorLock"] === commandClassId && !self.controller.devices.get(vDevId)) {

			defaults = {
				deviceType: 'doorlock',
				metrics: {
					level: '',
					icon: 'door',
					title: compileTitle('Door Lock', vDevIdNI)
				}
			};

			// apply postfix if available
			if (changeVDev[changeDevId]) {
				defaults = applyPostfix(defaults, changeVDev[changeDevId], vDevId, vDevIdNI);
			}

			var vDev = self.controller.devices.create({
				deviceId: vDevId,
				defaults: defaults,
				overlay: {},
				handler: function(command) {
					if ("open" === command) {
						cc.Set(0);
					} else if ("close" === command) {
						cc.Set(255);
					}
				},
				moduleId: self.id
			});
			if (vDev) {
				self.dataBind(self.gateDataBinding, self.zway, nodeId, instanceId, commandClassId, "mode", function(type) {
					try {
						if (!(type & self.ZWAY_DATA_CHANGE_TYPE["Invalidated"])) {
							vDev.set("metrics:level", this.value === 255 ? "close" : "open");
						}
					} catch (e) {}
				}, "value");
			}
		} else if (this.CC["BarrierOperator"] === commandClassId && !self.controller.devices.get(vDevId)) {

			defaults = {
				deviceType: 'doorlock',
				metrics: {
					level: '',
					icon: 'door',
					title: compileTitle('Garage Door', vDevIdNI)
				}
			};

			// apply postfix if available
			if (changeVDev[changeDevId]) {
				defaults = applyPostfix(defaults, changeVDev[changeDevId], vDevId, vDevIdNI);
			}

			var vDev = self.controller.devices.create({
				deviceId: vDevId,
				defaults: defaults,
				overlay: {},
				handler: function(command) {
					if ("open" === command) {
						cc.Set(255);
					} else if ("close" === command) {
						cc.Set(0);
					}
				},
				moduleId: self.id
			});
			if (vDev) {
				self.dataBind(self.gateDataBinding, self.zway, nodeId, instanceId, commandClassId, "state", function(type) {
					try {
						if (!(type & self.ZWAY_DATA_CHANGE_TYPE["Invalidated"])) {
							vDev.set("metrics:level", this.value === 255 ? "open" : "close");
						}
					} catch (e) {}
				}, "value");
			}
		} else if (this.CC["ThermostatMode"] === commandClassId || this.CC["ThermostatSetPoint"] === commandClassId) {
			var
				withMode = in_array(instanceCommandClasses, this.CC["ThermostatMode"]) && instance.ThermostatMode.data.supported.value,
				withTemp = in_array(instanceCommandClasses, this.CC["ThermostatSetPoint"]) && instance.ThermostatSetPoint.data.supported.value,
				deviceNamePrefix = "ZWayVDev_" + this.config.name + "_" + nodeId + separ + instanceId + separ;

			if ((withMode && !instance.ThermostatMode.data.interviewDone.value) || (withTemp && !instance.ThermostatSetPoint.data.interviewDone.value)) {
				return; // skip not finished interview
			}

			var MODE_OFF = 0, MODE_HEAT = 1, MODE_COOL = 2;

			if (withMode && !self.controller.devices.get(deviceNamePrefix + this.CC["ThermostatMode"])) {
				var withModeOff = !!instance.ThermostatMode.data[MODE_OFF],
					withModeHeat = !!instance.ThermostatMode.data[MODE_HEAT],
					withModeCool = !!instance.ThermostatMode.data[MODE_COOL];

				if (withModeOff && (withModeHeat || withModeCool)) {

					defaults = {
						deviceType: "switchBinary",
						probeType:'thermostat_mode',
						metrics: {
							icon: 'thermostat',
							title: compileTitle("Thermostat operation", vDevIdNI)
						}
					};

					// apply postfix if available
					if (changeVDev[changeDevId]) {
						defaults = applyPostfix(defaults, changeVDev[changeDevId], deviceNamePrefix + this.CC["ThermostatMode"], vDevIdNI);
					}

					var m_vDev = self.controller.devices.create({
						deviceId: deviceNamePrefix + this.CC["ThermostatMode"],
						defaults: defaults,
						overlay: {},
						handler: function (command) {
							if ("on" === command) {
								var lastMode = withModeHeat ? MODE_HEAT : MODE_COOL;
								
								// modes are not always same in ThermostatSetPoint and in ThermostatMode, but here they are same
								if (withModeHeat && withModeCool && instance.ThermostatSetPoint && instance.ThermostatSetPoint.data[MODE_HEAT] && instance.ThermostatSetPoint.data[MODE_COOL]) {
									lastMode = instance.ThermostatSetPoint.data[MODE_HEAT].setVal.updateTime > instance.ThermostatSetPoint.data[MODE_COOL].setVal.updateTime ? MODE_HEAT : MODE_COOL;
								}
								instance.ThermostatMode.Set(lastMode);
							} else if ("off" === command) {
								instance.ThermostatMode.Set(MODE_OFF);
							}
						},
						moduleId: self.id
					});

					if (m_vDev) {
						self.dataBind(self.gateDataBinding, self.zway, nodeId, instanceId, this.CC["ThermostatMode"], "mode", function (type) {
							try {
								if (!(type & self.ZWAY_DATA_CHANGE_TYPE["Invalidated"])) {
									m_vDev.set("metrics:level", this.value != MODE_OFF ? "on" : "off");
								}
							} catch (e) {}
						}, "value");
					}
				}
			}

			if (withTemp) {
				var withTempHeat = instance.ThermostatSetPoint.data[MODE_HEAT],
					withTempCool = instance.ThermostatSetPoint.data[MODE_COOL],
					modes = [];
				
				withTempHeat && modes.push(MODE_HEAT);
				withTempCool && modes.push(MODE_COOL);
				
				var t_vDev = [];
				modes.forEach(function(mode) {
					var cVDId = changeDevId + separ + mode;
					// check if it should be created
					if (!changeVDev[cVDId] || changeVDev[cVDId] && !changeVDev[cVDId].noVDev) {
						var DH = instance.ThermostatSetPoint.data[mode],
							_vDevId = deviceNamePrefix + self.CC["ThermostatSetPoint"] + "-" + mode;

						if (!self.controller.devices.get(_vDevId)) {

							var defaults = {
								deviceType: "thermostat",
									probeType: 'thermostat_set_point',
									metrics: {
									scaleTitle: DH.scaleString.value,
										level: DH.val.value,
										min: DH.min ? DH.min.value : (DH.scale.value === 0 ? 5 : 41),
										max: DH.max ? DH.max.value : (DH.scale.value === 0 ? 40 : 104),
										icon: 'thermostat',
										title: compileTitle("Thermostat " + (mode === MODE_HEAT ? "Heat" : "Cool"), vDevIdNI)
								}
							}

							// apply postfix if available
							if (changeVDev[cVDId]) {
								defaults = applyPostfix(defaults, changeVDev[cVDId], _vDevId, vDevIdNI);
							}

							t_vDev[mode] = self.controller.devices.create({
								deviceId: _vDevId,
								defaults: defaults,
								overlay: {},
								handler: function (command, args) {
									instance.ThermostatSetPoint.Set(mode, args.level);
									instance.ThermostatMode && instance.ThermostatMode.Set(mode == MODE_HEAT ? MODE_HEAT : MODE_COOL); // modes are not always same in ThermostatSetPoint and in ThermostatMode, but here they are same
								},
								moduleId: self.id
							});

							if (t_vDev[mode]) {
								self.dataBind(self.gateDataBinding, self.zway, nodeId, instanceId, self.CC["ThermostatSetPoint"], mode + ".setVal", function (type) {
									if (type === self.ZWAY_DATA_CHANGE_TYPE.Deleted) {
										delete t_vDev[mode];
										self.controller.devices.remove(_vDevId);
									} else {
										try {
											if (!(type & self.ZWAY_DATA_CHANGE_TYPE["Invalidated"])) {
												t_vDev[mode].set("metrics:level", this.value);
											}
										} catch (e) {
										}
									}
								});
							}
						}
					}
				});
			}
		} else if (this.CC["AlarmSensor"] === commandClassId) {
			a_defaults = {
				deviceType: 'sensorBinary',
				probeType: '',
				metrics: {
					icon: 'alarm',
					level: 'off',
					title: ''
				}
			};

			Object.keys(cc.data).forEach(function (sensorTypeId) {

					sensorTypeId = parseInt(sensorTypeId, 10);

					var a_id = vDevId + separ + sensorTypeId + separ + "A";

					if (!isNaN(sensorTypeId) && !self.controller.devices.get(a_id)) {
						var cVDId = changeDevId + separ + sensorTypeId;

						// check if it should be created
						if (!changeVDev[cVDId] || changeVDev[cVDId] && !changeVDev[cVDId].noVDev) {
							a_defaults.metrics.title = compileTitle('Alarm', cc.data[sensorTypeId].typeString.value, vDevIdNI);

							switch (sensorTypeId) {
								case 0:
									a_defaults.probeType = 'alarmSensor_general_purpose';
									break;
								case 1:
									a_defaults.probeType = 'alarmSensor_smoke';
									break;
								case 2:
									a_defaults.probeType = 'alarmSensor_co';
									break;
								case 3:
									a_defaults.probeType = 'alarmSensor_coo';
									break;
								case 4:
									a_defaults.probeType = 'alarmSensor_heat';
									break;
								case 5:
									a_defaults.probeType = 'alarmSensor_flood';
									break;
								case 6:
									a_defaults.probeType = 'alarmSensor_door';
									break;
								case 7:
									a_defaults.probeType = 'alarmSensor_burglar';
									break;
								case 8:
									a_defaults.probeType = 'alarmSensor_power';
									break;
								case 9:
									a_defaults.probeType = 'alarmSensor_system';
									break;
								case 10:
									a_defaults.probeType = 'alarmSensor_emergency';
									break;
								case 11:
									a_defaults.probeType = 'alarmSensor_clock';
									break;
								default:
									break;
							}

							// apply postfix if available
							if (changeVDev[cVDId]) {
								a_defaults = applyPostfix(a_defaults, changeVDev[cVDId], a_id, vDevIdNI);
							}

							var a_vDev = self.controller.devices.create({
								deviceId: a_id,
								defaults: a_defaults,
								overlay: {},
								handler: function (command) {
									if (command === "update") {
										cc.Get(sensorTypeId);
									}
								},
								moduleId: self.id
							});

							if (a_vDev) {
								self.dataBind(self.gateDataBinding, self.zway, nodeId, instanceId, commandClassId, sensorTypeId + ".sensorState", function (type) {
									if (type === self.ZWAY_DATA_CHANGE_TYPE.Deleted) {
										self.controller.devices.remove(vDevId + separ + sensorTypeId + separ + "A");
									} else {
										try {
											if (!(type & self.ZWAY_DATA_CHANGE_TYPE["Invalidated"])) {
												a_vDev.set("metrics:level", this.value ? "on" : "off");
											}
										} catch (e) {
										}
									}
								}, "value");
							}
						}
					}
			});
			if (!scaleAdded) {
				self.dataBind(self.gateDataBinding, self.zway, nodeId, instanceId, commandClassId, "", function(type) {
					if (type !== self.ZWAY_DATA_CHANGE_TYPE.Deleted) {
						self.parseAddCommandClass(nodeId, instanceId, commandClassId, true, changeVDev);
					}
				}, "child");
			}
		} else if (this.CC["Alarm"] === commandClassId) {
			if (cc.data.version.value < 3) return; // We skip old Alarm CC implementations handling only v3 (Notification)
			
			a_defaults = {
				deviceType: 'sensorBinary',
				probeType: '',
				metrics: {
					icon: 'alarm',
					level: 'off',
					title: ''
				}
			};
			Object.keys(cc.data).forEach(function (notificationTypeId) {

					notificationTypeId = parseInt(notificationTypeId, 10);

					if (!isNaN(notificationTypeId)) {
						var cVDId = changeDevId + separ + notificationTypeId;
						// check if it should be created
						if (!changeVDev[cVDId] || changeVDev[cVDId] && !changeVDev[cVDId].noVDev) {

							var DOOR_OPEN = 0x16, DOOR_CLOSE = 0x17;
							if (notificationTypeId === 0x06 && (cc.data[notificationTypeId].eventMask.value & ((1 << DOOR_OPEN) | (1 << DOOR_CLOSE)))) { // Very special case of Door
								a_defaults.metrics.icon = 'door';

								var a_id = vDevId + separ + notificationTypeId + separ + 'Door' + separ + "A";

								if (!self.controller.devices.get(a_id)) {
									a_defaults.metrics.title = compileTitle('Alarm', cc.data[notificationTypeId].typeString.value, vDevIdNI);
									a_defaults.probeType = 'alarm_door';

									// apply postfix if available
									if (changeVDev[cVDId]) {
										a_defaults = applyPostfix(a_defaults, changeVDev[cVDId], a_id, vDevIdNI);
									}

									var a_vDev = self.controller.devices.create({
										deviceId: a_id,
										defaults: a_defaults,
										overlay: {},
										handler: function (command) {
											if (command === "update") {
												cc.Get(0, notificationTypeId, DOOR_OPEN);
												cc.Get(0, notificationTypeId, DOOR_CLOSE);
											}
										},
										moduleId: self.id
									});

									if (a_vDev) {
										self.dataBind(self.gateDataBinding, self.zway, nodeId, instanceId, commandClassId, notificationTypeId.toString(10), function (type) {
											if (type === self.ZWAY_DATA_CHANGE_TYPE.Deleted) {
												self.controller.devices.remove(vDevId + separ + notificationTypeId + separ + 'Door' + separ + "A");
											} else {
												if (this.event.value === DOOR_OPEN || this.event.value === DOOR_CLOSE) {
													try {
														if (!(type & self.ZWAY_DATA_CHANGE_TYPE["Invalidated"])) {
															a_vDev.set("metrics:level", (this.event.value == DOOR_OPEN) ? "on" : "off");
														}
													} catch (e) {
													}
												}
											}
										}, "value");
									}
								}
							}

							// we handle only few Notification Types
							switch (notificationTypeId) {
								case 0x01: // Smoke
									a_defaults.metrics.icon = 'smoke';
									a_defaults.probeType = 'alarm_smoke';
									break;
								case 0x02: // CO
									a_defaults.metrics.icon = 'co';
									a_defaults.probeType = 'alarm_co';
									break;
								case 0x03: // CO2
									a_defaults.metrics.icon = 'co';
									a_defaults.probeType = 'alarm_coo';
									break;
								case 0x04: // Heat
									a_defaults.metrics.icon = 'alarm';
									a_defaults.probeType = 'alarm_heat';
									break;
								case 0x05: // Water
									a_defaults.metrics.icon = 'flood';
									a_defaults.probeType = 'alarm_flood';
									break;
								case 0x07: // Home Security (Burglar)
									a_defaults.metrics.icon = 'smoke';
									a_defaults.probeType = 'alarm_burglar';
									break;
								case 0x08: // Power
									a_defaults.metrics.icon = 'alarm';
									a_defaults.probeType = 'alarm_power';
									break;
								case 0x09: // System
									a_defaults.metrics.icon = 'alarm';
									a_defaults.probeType = 'alarm_system';
									break;
								case 0x0a: // Emergency
									a_defaults.metrics.icon = 'alarm';
									a_defaults.probeType = 'alarm_emergency';
									break;
								case 0x0b: // Clock
									a_defaults.metrics.icon = 'alarm';
									a_defaults.probeType = 'alarm_clock';
									break;
								default:
									return; // skip this type
							}

							maskToTypes = function (bitmask) {
								var types = [], n = 0;

								while (bitmask) {
									if (bitmask & 0x01) {
										types.push(n);
									}
									n++;
									bitmask >>= 1;
								}

								return types;
							};

							// handle 0xFE unknown
							// special case by Sigma for Unknown event - not listed in eventMask
							// the vDev for this event will be created on the fly
							{
								if (!self.ccAlarmUnknownEventBinded) {
									self.ccAlarmUnknownEventBinded = [];
								}
								var a_id = vDevId + separ + notificationTypeId + separ + 0xFE + separ + "A";
								if (!self.ccAlarmUnknownEventBinded[a_id]) {
									self.ccAlarmUnknownEventBinded[a_id] = true;
									self.dataBind(self.gateDataBinding, self.zway, nodeId, instanceId, commandClassId, notificationTypeId.toString(10) + ".event", function (type) {
										var eventTypeId = parseInt(this.value, 10);
										if (eventTypeId === 0xFE) {
											var cVDId = changeDevId + separ + notificationTypeId + separ + eventTypeId;
											// check if it should be created
											if (!changeVDev[cVDId] || changeVDev[cVDId] && !changeVDev[cVDId].noVDev) {

												if (!self.controller.devices.get(a_id)) {
													a_defaults.metrics.title = compileTitle('Alarm', cc.data[notificationTypeId].typeString.value, vDevIdNI);

													// apply postfix if available
													if (changeVDev[cVDId]) {
														a_defaults = applyPostfix(a_defaults, changeVDev[cVDId], a_id, vDevIdNI);
													}

													var a_vDev = self.controller.devices.create({
														deviceId: a_id,
														defaults: a_defaults,
														overlay: {},
														handler: function (command) {
															if (command === "update") {
																cc.Get(0, notificationTypeId, eventTypeId);
															}
														},
														moduleId: self.id
													});

													if (a_vDev) {
														self.dataBind(self.gateDataBinding, self.zway, nodeId, instanceId, commandClassId, notificationTypeId.toString(10), function (type) {
															if (type === self.ZWAY_DATA_CHANGE_TYPE.Deleted) {
																self.controller.devices.remove(vDevId + separ + notificationTypeId + separ + eventTypeId + separ + "A");
															} else {
																if (this.event.value === eventTypeId || this.event.value === 0) {
																	try {
																		if (!(type & self.ZWAY_DATA_CHANGE_TYPE["Invalidated"])) {
																			a_vDev.set("metrics:level", this.event.value ? "on" : "off");
																		}
																	} catch (e) {
																	}
																}
															}
														}, "value");
													}
												}
											}
										}
									});
								}
							}

							maskToTypes(cc.data[notificationTypeId].eventMask.value).forEach(function (eventTypeId) {

								eventTypeId = parseInt(eventTypeId, 10);

								var a_id = vDevId + separ + notificationTypeId + separ + eventTypeId + separ + "A";

								if (!isNaN(eventTypeId) && !self.controller.devices.get(a_id)) {
									var cVDId = changeDevId + separ + notificationTypeId + separ + eventTypeId;
									// check if it should be created
									if (!changeVDev[cVDId] || changeVDev[cVDId] && !changeVDev[cVDId].noVDev) {
										a_defaults.metrics.title = compileTitle('Alarm', cc.data[notificationTypeId].typeString.value, vDevIdNI);

										// apply postfix if available
										if (changeVDev[cVDId]) {
											a_defaults = applyPostfix(a_defaults, changeVDev[cVDId], a_id, vDevIdNI);
										}

										var a_vDev = self.controller.devices.create({
											deviceId: a_id,
											defaults: a_defaults,
											overlay: {},
											handler: function (command) {
												if (command === "update") {
													cc.Get(0, notificationTypeId, eventTypeId);
												}
											},
											moduleId: self.id
										});

										if (a_vDev) {
											self.dataBind(self.gateDataBinding, self.zway, nodeId, instanceId, commandClassId, notificationTypeId.toString(10), function (type) {
												if (type === self.ZWAY_DATA_CHANGE_TYPE.Deleted) {
													self.controller.devices.remove(vDevId + separ + notificationTypeId + separ + eventTypeId + separ + "A");
												} else {
													if (this.event.value === eventTypeId || this.event.value === 0) {
														try {
															if (!(type & self.ZWAY_DATA_CHANGE_TYPE["Invalidated"])) {
																a_vDev.set("metrics:level", this.event.value ? "on" : "off");
															}
														} catch (e) {
														}
													}
												}
											}, "value");
										}
									}
								}
							});
						}
					}
			});
			if (!scaleAdded) {
				self.dataBind(self.gateDataBinding, self.zway, nodeId, instanceId, commandClassId, "", function(type) {
					if (type !== self.ZWAY_DATA_CHANGE_TYPE.Deleted) {
						self.parseAddCommandClass(nodeId, instanceId, commandClassId, true, changeVDev);
					}
				}, "child");
			}
		} else if (this.CC["CentralScene"] === commandClassId) {

			var devId = vDevId + separ + 'DS';

			defaults = {
				deviceType: 'sensorDiscrete',
				probeType: 'control',
				metrics: {
					probeTitle: 'Control',
					icon: 'gesture',
					level: '',
					title: compileTitle('Sensor', 'Control', vDevIdNI),
                    state: '',
					/* GESTURES (state):
					 * hold,
					 * press / tap (cnt),
					 * release,
					 * swipe_up,
					 * swipe_down,
					 * swipe_left,
					 * swipe_right,
					 * swipe_top_left_to_bottom_right,
					 * swipe_top_right_to_bottom_left,
					 * swipe_bottom_left_to_top_right,
					 * swipe_bottom_right_to_top_left
					 */
					currentScene: '',
					discreteStates: {}
				}
			};

			// apply postfix if available
			if (changeVDev[changeDevId]) {
				defaults = applyPostfix(defaults, changeVDev[changeDevId], devId, vDevIdNI);
			}

			var vDev = self.controller.devices.create({
				deviceId: devId,
				defaults: defaults,
				overlay: {},
				handler: function (command) {
					if (command === "update") {
						cc.Get;
					}
				},
				moduleId: self.id
			});

			if (vDev) {
				self.dataBind(self.gateDataBinding, self.zway, nodeId, instanceId, commandClassId, "currentScene", function(type) {
					if (type === self.ZWAY_DATA_CHANGE_TYPE["Deleted"]) {
						self.controller.devices.remove(devId);
					} else {
						try {
							if (!(type & self.ZWAY_DATA_CHANGE_TYPE["Invalidated"])) {
								// output curScene + keyAttr or ''
								var cS = cc.data['currentScene'].value && !!cc.data['currentScene'].value? cc.data['currentScene'].value : 0,
									mC = cc.data['maxScenes'].value && !!cc.data['maxScenes'].value? cc.data['maxScenes'].value : 0,
									kA = cc.data['keyAttribute'].value && !!cc.data['keyAttribute'].value? cc.data['keyAttribute'].value : 0,
									/*
									 * CentralScene v3:
									 *
									 * 0x00 Key Pressed 1 time
									 * 0x01 Key Released
									 * 0x02 Key Held Down
									 * 0x03 Key Pressed 2 times
									 * 0x04 Key Pressed 3 times
									 * 0x05 Key Pressed 4 times
									 * 0x06 Key Pressed 5 times
									 */
									kaCnt = kA > 0x02? kA - 0x01 : 0x01,
									cL = cS.toString() + kA.toString(),
									dS = !_.isEmpty(defaults.metrics.discreteStates) && defaults.metrics.discreteStates[cL]? defaults.metrics.discreteStates[cL] : undefined,
									st = '',
									cnt = dS && dS['cnt']? dS['cnt'] : kaCnt,
									type = dS && dS['type']? dS['type'] : 'B',
									setAction = function () {
										switch (kA) {
											case 0x01:
												st = dS && dS['action']? dS['action'] : 'release';
												break;
											case 0x02:
												st = dS && dS['action']? dS['action'] : 'hold';
												break;
											default:
												st = dS && dS['action']? dS['action'] : 'press';
												break;
										}
									};


								setAction();

								vDev.set("metrics:state", st);
								vDev.set("metrics:currentScene", cS);
								vDev.set("metrics:keyAttribute", kA);
								vDev.set("metrics:maxScenes", mC);
								vDev.set("metrics:level", cL);
								vDev.set("metrics:cnt", cnt);
								vDev.set("metrics:type", type);
							}
						} catch (e) {
						}
					}
				}, "value");
			}
		} else if (this.CC["DeviceResetLocally"] === commandClassId) {
			self.dataBind(self.gateDataBinding, self.zway, nodeId, instanceId, commandClassId, "reset", function(type) {
				if (this.value) {
					var moduleName = self.getName(),
					    langFile = self.controller.loadModuleLang(moduleName);
					
					self.controller.addNotification("error", langFile.err_reset + nodeId, "connection", moduleName);
				}
			});
		}
	} catch (e) {
		var moduleName = this.getName(),
		    langFile = this.controller.loadModuleLang(moduleName),
		    values = nodeId + "-" + instanceId + "-" + commandClassId + ": " + e.toString();
			
		controller.addNotification("error", langFile.err_dev_create + values, "core", moduleName);
		console.log(e.stack);
	}
};

ZWave.prototype.parseDelCommandClass = function (nodeId, instanceId, commandClassId) {
	nodeId = parseInt(nodeId, 10);
	instanceId = parseInt(instanceId, 10);
	commandClassId = parseInt(commandClassId, 10);

	var self = this,
		separ = "-",
		vDevIdPrefix = "ZWayVDev_" + this.config.name + "_",
		vDevIdNI = nodeId + separ + instanceId,
		vDevIdC = commandClassId,
		vDevId = vDevIdPrefix + vDevIdNI + separ + vDevIdC;

	this.controller.devices.remove(vDevId);
};

ZWave.prototype.rssiData = function(data) {
    var now = Math.round((new Date()).getTime()/1000);

    var data = data? data : [];

    zway.GetBackgroundRSSI();

    var rssi = zway.controller.data.statistics.backgroundRSSI;

    var d = {
        "time": now,
        "channel1": (rssi.channel1.value - 256) >= -115 && !_.isNaN(rssi.channel1.value)? rssi.channel1.value - 256 : null,
        "channel2": (rssi.channel2.value - 256) >= -115 && !_.isNaN(rssi.channel2.value)? rssi.channel2.value - 256 : null,
        "channel3": (rssi.channel3.value - 256) >= -115 && !_.isNaN(rssi.channel3.value)? rssi.channel3.value - 256 : null
    };

    data.push(d);

    return data;
}