/*
 * name: node-monitor
 * version: 0.3.5
 * description: Node.js server monitor module
 * repository: git://github.com/shunanya/Node.js-monitoring.git
 * dependencies: 
 *   log4js: > 0.4.0
 *   node_hash: >= 0.2.0
 * copyright : (c) 20012 Monitis
 * license : MIT
 */
var events = require('events')
	,sys = require('util')
	,http = require('http')
	,url = require('url')
	,hash = require('node_hash')
	,utils = require('./util/utils');

//exports.Logger = Logger = require('./util/logger');
//var logger = Logger.Logger('node_monitor');

// ****** Constants ******
var HOST_LISTEN = "127.0.0.1";
var PORT_LISTEN = 10010;
var MAX_VALUE = Number.MAX_VALUE;
var TOP_VIEW = 3; // The maximum number of viewable requests that spent most time for execution
var TOP_LIMIT = 100; // The maximum number of collected requests that spent most time for execution
var TOP_TIMELIMIT = 1; // the monitor have to collect info when exceeding the number of specified seconds only
var TOP_SORTBY = 'max_time'; // the collected paths sorting key
var STATUS_OK = 1;
var STATUS_NOK = 0;
var STATUS_DOWN = 2;
var STATUS_IDLE = 3;
// ***********************

var monitor_server = null;

var monitors = [];

var custom_metrics = {};

function createMon() {
	// monitored data structure
	var mon = {
		// options
		'collect_all' : false,
		'indexPathNames': 0,
		// fixed part
		'server' : null,
		'listen' : "",
		'requests' : 0,
		'post_count' : 0,
		'exceptions' : 0,
		'get_count' : 0,
		'active' : 0,
		// Total
		'time' : 0,
		'avr_time' : 0,
		'min_time' : MAX_VALUE,
		'max_time' : 0,
		// Network latency
		'net_time' : 0,
		'avr_net_time' : 0,
		'min_net_time' : MAX_VALUE,
		'max_net_time' : 0,
		// Server responce time
		'resp_time' : 0,
		'avr_resp_time' : 0,
		'min_resp_time' : MAX_VALUE,
		'max_resp_time' : 0,
		// Read/Writes
		'bytes_read' : 0,
		'bytes_written' : 0,
		// Status codes
		'1xx' : 0,
		'2xx' : 0,
		'3xx' : 0,
		'4xx' : 0,
		'timeout' : 0,// status code 408
		'5xx' : 0,
		'timeS' : new Date().getTime(),
		'timeE' : new Date().getTime(),
		'status' : STATUS_IDLE,
		// flexible part
		'info' : {
			'add' : function(name, key, value) {
				if (!this[name]) {
					this[name] = {};
				}
				if (this[name][key]) {
					this[name][key] += value != undefined ? value : 1;
				} else {
					this[name][key] = value != undefined ? value : 1;
				}
			},
			//{'path':<value>,'max_time':<value>[,'rate':<value>,'count':<value>]}
			'addPathNames' : function(path_obj) {
				var self = this;
				if (TOP_VIEW <= 0 || TOP_LIMIT <= 0
						|| (typeof (path_obj['max_time']) == 'number' && (TOP_TIMELIMIT * 1000 > path_obj['max_time']))) {
					return;
				}
				if (!self['paths']) {
					self['paths'] = {};
					mon.indexPathNames = 0;
				}
				var obj = self['paths'];
				var pathname = path_obj['path'];
				var time = path_obj['max_time'];
				var rate = path_obj['rate'];
				var count = path_obj['count'];
				var hash = utils.hashCode(pathname);
				if (obj[hash] == undefined) {// adds a new item
					if (mon.indexPathNames >= TOP_LIMIT) {
						//logger.warn("Collecting requests: Count of collected requests exceeds specified limit (" 
						//		+ TOP_LIMIT	+ ")");
						return;
					}
					obj[hash] = {// update existing item
						'path' : pathname,
						'max_time' : time,
						'rate' : (rate != undefined ? rate : time),
						'count' : (count != undefined ? count : 1)
					};
					mon.indexPathNames++;
				} else {
					if (obj[hash]['path'] == pathname) {
						obj[hash]['count'] += (count != undefined ? count : 1);
						obj[hash]['max_time'] = Math.max(obj[hash]['max_time'], time);
						obj[hash]['rate'] += (rate != undefined ? rate : time);
					}
				}
			},
			'addSorted' : function(name, data, sort_key_value) {
				var value = sort_key_value/1000;
				if (TOP_VIEW <= 0 || TOP_TIMELIMIT > value) {
					return;
				}
				if (!this[name]) {
					this[name] = [];
				}
				var t = {
					't' : value,
					'data' : data
				};
				this[name].push(t);
				if (this[name].length > 1) {
					this[name].sort(function(a, b) {
						return b['t'] - a['t'];
					})
				}
				if (this[name].length > TOP_VIEW) {
					this[name].pop();
				}
			},
			'addAll' : function(info) {
				var self = this;
				var _name = "";
				function isArray(obj) {
					return obj.constructor == Array;
				}
				JSON.stringify(info, function(key, value) {
					if (typeof (value) == 'object') {
						if (isArray(value)) {
							value.forEach(function(element, index, value) {
								self.addSorted(key, element['data'], element['t'])
							}, self);
							return undefined;
						} else {
							_name = key;
							if (value['path'] && value['max_time']) {
								self.addPathNames({'path':value['path'], 'max_time':value['max_time'], 'rate':value['rate'], 'count':value['count']});
								return undefined;
							}
						}
					} else if (typeof (value) != 'function' && _name.length > 0) {
						self.add(_name, key, value);
					}
					return value;
				});
			}
		}

	};
	return mon;
}

/**
 * Adds the given server to the monitor chain
 * 
 * @param server
 *            {Object}
 * @param options
 *            {Object} the options for given server monitor 
 *            {'collect_all': ('yes' | 'no'), 'top':{'max':<value>, 'limit':<value>, 'sortby':<value>}} 
 *      where 
 *      	  top.view - the number of viewable part of collected requests
 *      	  top.limit - the maximum number of collected requests that spent most time for execution 
 *            top.timelimit - the monitor have to collect info when exceeding the number of specified seconds only
 *            top.sortby - sorting by {max_time | rate | count | load}
 *            default - {'collect_all': 'no', 'top':{'view':3,'limit':100, 'timelimit':1, 'sortby': 'max_time'}}
 * @returns {Object} mon_server structure if given server added to the monitor chain 
 * 					null if server is already in monitor
 */
function addToMonitors(server, options) {
    if (null == monitor_server) {
        bind(PORT_LISTEN);
    }
	var collect_all = false;
	if ('object' == typeof(options)) {// Parse options
		//logger.debug("Trying to register Monitor: " + JSON.stringify(options));
		collect_all = (options['collect_all'] && options['collect_all'] == 'yes') ? true : false;
		if (options['top']) {
			if (typeof(options['top']['view']) == 'number') {
				TOP_VIEW = Math.max(TOP_VIEW, Math.max(options['top']['view'], 0));
			}
			if (typeof(options['top']['limit']) == 'number') {
				TOP_LIMIT = Math.max(options['top']['limit'], 0);
			}
			if (typeof(options['top']['timelimit']) == 'number') {
				TOP_TIMELIMIT = 1000*Math.max(options['top']['timelimit'], 0);
			}
			if (typeof(options['top']['sortby']) == 'string' &&
				(options['top']['sortby'] == 'max_time' || options['top']['sortby'] == 'rate' || 
				 options['top']['sortby'] == 'count' || options['top']['sortby'] == 'load')) {
				TOP_SORTBY = options['top']['sortby'];
			}
		}
		
	}

	if (server && (monitors.length == 0 || !monitors.some(function(element) {return element['server'] == server;}))) {
		var mon_server = createMon();
		mon_server['collect_all'] = collect_all;
		mon_server['server'] = server;
		var address = server.address();
		var host = '0.0.0.0';
		var port = 'na';
		if (address){
			port = address['port'];
			host = address['address'];
		} else if (options['server_port']) {
            port = options['server_port'];
        }
		mon_server['listen'] = port;
		monitors.push(mon_server);
		console.log("Server " + host + ":" + port + " registered for monitoring, parameters: "
				+"{'collect_all': " + collect_all
				+ ", 'top':{'view':" + TOP_VIEW + ",'limit':" + TOP_LIMIT + ", 'timelimit':" + TOP_TIMELIMIT
				+ ", 'sortby':'" + TOP_SORTBY + "'}}");
		return mon_server;
	}
	//logger.warn("Could not add the same server");
	return null;
}

/**
 * Removes given server from monitor chain
 * 
 * @param server
 */
function removeFromMonitor(server) {
	if (server && monitors.length > 0) {
		for ( var i = 0; i < monitors.length; i++) {
			var mon_server = monitors[i];
			if (mon_server['server'] == server) {
				//logger.info("Server " + server.address()['address'] + ":" + server.address()['port']
				//		+ " stopped and removed from monitors chain");
				monitors.splice(i, 1);// remove monitored element
			}
		}
	}
}

function addExceptionToMonitor(server, callback) {
	var ret = false;
	if (server && monitors.length > 0) {
		for ( var i = 0; i < monitors.length; i++) {
			var mon_server = monitors[i];
			if (mon_server['server'] == server && mon_server.hasOwnProperty('exceptions')) {
				++mon_server['exceptions'];
				ret = true;
				break;
			}
		}
	}
	return (callback ? (callback(!ret)) : (ret));
}
exports.addExceptionToMonitor = addExceptionToMonitor;

/**
 * Adds measured values into monitor
 * @param server	monitored server
 * @param requests	count of requests
 * @param post_count count of POST requests
 * @param get_count	count of GET requests
 * @param params	object that contains measured results
 * @param status_code response status code
 * @param callback	function(error)
 * @returns	true on succes
 */
function addResultsToMonitor(server, requests, post_count, get_count, params, status_code, callback) {
	var ret = false;
	if (server && monitors.length > 0 && typeof params == 'object') {
		var pathname = params['pathname'];
		var net_duration = params['net_duration']; 
		var pure_duration = params['pure_duration']; 
		var total_duration = params['total_duration']; 
		var bytes_read = params['Read'];
		var bytes_written = params['Written']; 
		var info = params['info']; 
		var userInfo = params['user'];
		for ( var i = 0; i < monitors.length; i++) {
			var mon_server = monitors[i];
			if (mon_server['server'] == server) {
				// logger.debug("adding parameters...");
				mon_server['time'] += total_duration;
				mon_server['min_time'] = Math.min(total_duration, mon_server['min_time']);
				if (status_code != 408)// timeout shouldn't be calculated
					mon_server['max_time'] = Math.max(total_duration, mon_server['max_time']);
				mon_server['resp_time'] += pure_duration;
				mon_server['min_resp_time'] = Math.min(pure_duration, mon_server['min_resp_time']);
				if (status_code != 408)// timeout shouldn't be calculated
					mon_server['max_resp_time'] = Math.max(pure_duration, mon_server['max_resp_time']);
				mon_server['net_time'] += net_duration;
				mon_server['min_net_time'] = Math.min(net_duration, mon_server['min_net_time']);
				if (status_code != 408)// timeout shouldn't be calculated
					mon_server['max_net_time'] = Math.max(net_duration, mon_server['max_net_time']);
				mon_server['active'] += ((net_duration + pure_duration) / 1000);
				mon_server['requests'] += requests;
				mon_server['avr_time'] = mon_server['time'] / mon_server['requests'];
				mon_server['avr_resp_time'] = mon_server['resp_time'] / mon_server['requests'];
				mon_server['avr_net_time'] = mon_server['net_time'] / mon_server['requests'];
				mon_server['post_count'] += post_count;
				mon_server['get_count'] += get_count;
				mon_server['bytes_read'] += bytes_read;
				mon_server['bytes_written'] += bytes_written;
				mon_server['1xx'] += (status_code < 200 ? 1 : 0);
				mon_server['2xx'] += (status_code >= 200 && status_code < 300 ? 1 : 0);
				mon_server['3xx'] += (status_code >= 300 && status_code < 400 ? 1 : 0);
				mon_server['4xx'] += (status_code >= 400 && status_code < 500 ? 1 : 0);
				mon_server['5xx'] += (status_code >= 500 ? 1 : 0);
				mon_server['timeout'] += (status_code == 408 ? 1 : 0);// DEBUG
				mon_server['timeE'] = new Date().getTime();
				if (typeof(info) == 'object') {
					mon_server['info'].addAll(info);
				}
				if (typeof(userInfo) == 'object') {
					mon_server['info'].addSorted('top' + TOP_VIEW, userInfo, total_duration);
				}
				if (pathname){
					mon_server['info'].addPathNames({'path':pathname, 'max_time':total_duration});
				}
				ret = true;
				break;
			}
		}
	}
	return (callback ? (callback(!ret)) : (ret));
}

/**
 * Composes all monitored servers data in following form <server1 data string> <server2 data string> ......
 * 
 * @param clean
 *            (optional) if given, 
 *            it is forcing to clear all accumulated data after composing a summarized result string
 * 
 * @returns {String}
 */
function getMonitorAllResults(clean) {
	var res = "";
	for ( var i = 0; i < monitors.length; i++) {
		res += monitorResultsToScalexString(monitors[i]);
		//res += "\n";
	}
	if (clean) {
		cleanAllMonitorResults();
	}
	return res;
}

/**
 * Returns total (summarized) monitored results
 * 
 * @param clean
 *            (optional) if given, 
 *            it is forcing to clear all accumulated data after composing a summarized result string
 * @returns {String} the total monitored result string
 */
function getMonitorTotalResult(clean) {
	var sum = createMon();
	for ( var i = 0; i < monitors.length; i++) {
		var mon = monitors[i];
		if (sum['listen'].length <= 0) {
			sum['listen'] = mon['listen'];
		} else {
			sum['listen'] += ',' + mon['listen'];
		}
		sum['min_time'] = Math.min(sum['min_time'], mon['min_time']);
		sum['max_time'] = Math.max(sum['max_time'], mon['max_time']);
		sum['time'] += mon['time'];
		sum['min_net_time'] = Math.min(sum['min_net_time'], mon['min_net_time']);
		sum['max_net_time'] = Math.max(sum['max_net_time'], mon['max_net_time']);
		sum['net_time'] += mon['net_time'];
		sum['min_resp_time'] = Math.min(sum['min_resp_time'], mon['min_resp_time']);
		sum['max_resp_time'] = Math.max(sum['max_resp_time'], mon['max_resp_time']);
		sum['resp_time'] += mon['resp_time'];
		sum['exceptions'] += mon['exceptions'];
		sum['active'] += mon['active'];
		sum['requests'] += mon['requests'];
		sum['post_count'] += mon['post_count'];
		sum['get_count'] += mon['get_count'];
		sum['bytes_read'] += mon['bytes_read'];
		sum['bytes_written'] += mon['bytes_written'];
		sum['1xx'] += mon['1xx'];
		sum['2xx'] += mon['2xx'];
		sum['3xx'] += mon['3xx'];
		sum['4xx'] += mon['4xx'];
		sum['5xx'] += mon['5xx'];
		sum['timeout'] += mon['timeout'];
		sum['timeS'] = Math.min(sum['timeS'], mon['timeS']);
		sum['timeE'] = Math.max(sum['timeE'], mon['timeE']);
		sum.info.addAll(mon.info);
	}
	if (sum['active'] <= 0) {
		sum['avr_time'] = 0;
		sum['avr_resp_time'] = 0;
		sum['avr_net_time'] = 0;
	} else {
		sum['avr_time'] = sum['time'] / sum['requests'];
		sum['avr_resp_time'] = sum['resp_time'] / sum['requests'];
		sum['avr_net_time'] = sum['net_time'] / sum['requests'];
	}
	if (clean) {
		cleanAllMonitorResults();
	}
    updateStatus(sum);
	return monitorResultsToScalexString(sum);
}

function getMonitorResults(server) {
	var ret = "";
	if (server && monitors.length > 0) {
		for ( var i = 0; i < monitors.length; i++) {
			var mon_server = monitors[i];
			if (mon_server['server'] == server) {
				//logger.debug("getting monitor parameters...");
				ret = monitorResultsToScalexString(mon_server);
				break;
			}
		}
	}
	return ret;
}

function updateStatus(mon_server) {
    if (mon_server['listen'].length == 0) {
		mon_server['status'] = STATUS_DOWN;
	} else if (mon_server['requests'] == 0) {
		mon_server['status'] = STATUS_IDLE;
	} else if ((mon_server['max_net_time'] != 0 && mon_server['avr_net_time'] / mon_server['max_net_time'] > 0.9)
			|| (mon_server['max_resp_time'] != 0 && mon_server['avr_resp_time'] / mon_server['max_resp_time'] > 0.9)) {
		mon_server['status'] = STATUS_NOK;
	} else {
		mon_server['status'] = STATUS_OK;
	} 
}

/**
 * Returns the composed string in the following form
 * 
 * <fixed part of data> | <flexible (optional part of data)>
 * 
 * where the fixed part item has key:value form and flexible part represents in JSON form like
 * {name1:{name11:value11,...},name2:{name21:vale21,...}...}
 * 
 * @param mon_server
 *            the collecting monitored data structure
 * @returns composed string that represents a monitoring data
 */
function monitorResultsToString(mon_server) {
	var time_window = ((new Date().getTime()) - mon_server['timeS']) / 1000; // monitoring time window in sec
	var time_idle = time_window - mon_server['active'];
	var load = mon_server['requests'] / time_window;
	ret = "status:" + mon_server['status'] + ";uptime:" + escape(utils.formatTimestamp(process.uptime()))
	// + ";min_net:"+(mon_server['min_net_time']==max_value?0:(mon_server['min_net_time']/1000)).toFixed(3)
	+ ";avr_net:" + (mon_server['avr_net_time'] / 1000).toFixed(3) + ";max_net:"
			+ (mon_server['max_net_time'] / 1000).toFixed(3)
			// + ";min_resp:"+(mon_server['min_resp_time']==max_value?0:(mon_server['min_resp_time']/1000)).toFixed(3)
			+ ";avr_resp:" + (mon_server['avr_resp_time'] / 1000).toFixed(3) + ";max_resp:"
			+ (mon_server['max_resp_time'] / 1000).toFixed(3)
			// + ";min_total:"+(mon_server['min_time']==max_value?0:(mon_server['min_time']/1000)).toFixed(3)
			+ ";avr_total:" + (mon_server['avr_time'] / 1000).toFixed(3) + ";max_total:"
			+ (mon_server['max_time'] / 1000).toFixed(3) + ";in_rate:"
			+ ((mon_server['bytes_read'] / time_window / 1000).toFixed(3)) + ";out_rate:"
			+ ((mon_server['bytes_written'] / time_window / 1000).toFixed(3)) + ";active:"
			+ (mon_server['active'] / time_window * 100).toFixed(2) + ";load:" + (load).toFixed(3);
	// + ";OFD:"+OFD;
	if (mon_server['requests'] > 0) {
		if (mon_server['info']['paths'] && TOP_VIEW > 0) {
			var sorted = utils.sortObject(mon_server['info']['paths'], {
				'byprop' : TOP_SORTBY, 'descending' : true, 'top' : TOP_VIEW, 'format' : 3,
				'array_option' : [ 
					  {'property' : 'load', 'action' : 'divide', 'param1' : 'count', 'param2' : time_window}
					, {'property' : 'rate', 'action' : 'divide', 'param1' : 'rate', 'param2' : 'count'}
		            , {'property':'rate', 'action':'divide', 'param1':'rate', 'param2':1000}
		            , {'property':'max_time', 'action':'divide', 'param1':'max_time', 'param2':1000}]
			});
			delete mon_server['info']['paths'];
			if (sorted.length > 0) {
				var new_key = "sorted by \'" + TOP_SORTBY + "\' (top " + TOP_VIEW + ")";
				mon_server['info'][new_key] = sorted;
			}
		}
		mon_server['info'].add('platform', "total", mon_server['requests']);
		mon_server['info'].add("codes", "1xx", mon_server['1xx']);
		mon_server['info'].add("codes", "2xx", mon_server['2xx']);
		mon_server['info'].add("codes", "3xx", mon_server['3xx']);
		mon_server['info'].add("codes", "4xx", mon_server['4xx']);
		mon_server['info'].add("codes", "408", mon_server['timeout']);
		mon_server['info'].add("codes", "5xx", mon_server['5xx']);
		mon_server['info']['post'] = ((mon_server['post_count'] / mon_server['requests'] * 100)).toFixed(1);
		mon_server['info']['2xx'] = (100 * mon_server['2xx'] / mon_server['requests']).toFixed(1);
		mon_server['info']['exc'] = mon_server['exceptions'];
	}
	mon_server['info']['mon_time'] = (time_window).toFixed(3);
	mon_server['info']["listen"] = '{' + mon_server['listen'] + '}';
	ret += " | " + JSON.stringify(mon_server['info']).toString(); // additional (variable part) results
	return ret;
}

function metricLine(mon_server, metric, value) {
    var port = mon_server.listen || "";
    //logger.info("metricLine, mon_server: " + mon_server.listen);
    return "nodejs." + metric + "[" + port + "]:" + value + "\n";
}

function monitorResultsToScalexString(mon_server) {
	var time_window = ((new Date().getTime()) - mon_server['timeS']) / 1000; // monitoring time window in sec
	var time_idle = time_window - mon_server['active'];
	var load = mon_server['requests'] / time_window;
    updateStatus(mon_server);
	ret = metricLine(mon_server, "status", mon_server['status'])
        + metricLine(mon_server, "uptime", process.uptime())
        + metricLine(mon_server, "avr_net", (mon_server['avr_net_time'] / 1000).toFixed(3))
        + metricLine(mon_server, "max_net", (mon_server['max_net_time'] / 1000).toFixed(3))
        + metricLine(mon_server, "avr_resp", (mon_server['avr_resp_time'] / 1000).toFixed(3))
        + metricLine(mon_server, "max_resp", (mon_server['max_resp_time'] / 1000).toFixed(3))
        + metricLine(mon_server, "avr_total", (mon_server['avr_time'] / 1000).toFixed(3))
        + metricLine(mon_server, "max_total", (mon_server['max_time'] / 1000).toFixed(3))
        + metricLine(mon_server, "in_rate", ((mon_server['bytes_read'] / time_window / 1000).toFixed(3)))
        + metricLine(mon_server, "out_rate", ((mon_server['bytes_written'] / time_window / 1000).toFixed(3)))
        + metricLine(mon_server, "active", (mon_server['active'] / time_window * 100).toFixed(2))
        + metricLine(mon_server, "load", (load).toFixed(3));
			
	//if (mon_server['requests'] > 0) {
        ret += metricLine(mon_server, "requests", mon_server['requests']);
        ret += metricLine(mon_server, "codes_1xx", mon_server['1xx']);
        ret += metricLine(mon_server, "codes_2xx", mon_server['2xx']);
        ret += metricLine(mon_server, "codes_3xx", mon_server['3xx']);
        ret += metricLine(mon_server, "codes_4xx", mon_server['4xx']);
        ret += metricLine(mon_server, "codes_408", mon_server['timeout']);
        ret += metricLine(mon_server, "codes_5xx", mon_server['5xx']);        
        var post = mon_server['requests'] > 0 ? ((mon_server['post_count'] / mon_server['requests'] * 100)).toFixed(1) : 0;
        var ok = mon_server['requests'] > 0 ? (100 * mon_server['2xx'] / mon_server['requests']).toFixed(1) : 0
        ret += metricLine(mon_server, "post", post);
        ret += metricLine(mon_server, "2xx", ok);
        ret += metricLine(mon_server, "exceptions", mon_server['exceptions']);
	//}
    
    ret += metricLine(mon_server, "mon_time", (time_window).toFixed(3));
    ret += metricLine(mon_server, "listen", mon_server['listen']);

	return ret;
}


function cleanAllMonitorResults() {
	for ( var i = 0; i < monitors.length; i++) {
		monitors[i] = monitorResultsClean(monitors[i]);
	}
}

function cleanMonitorResults(server) {
	var ret = false;

	if (server && monitors.length > 0) {
		for ( var i = 0; i < monitors.length; i++) {
			if (monitors[i]['server'] == server) {
				//logger.debug("cleaning parameters...");
				monitors[i] = monitorResultsClean(monitors[i]);
				ret = true;
				break;
			}
		}
	}
	return ret;
}

function monitorResultsClean(mon_server) {
	var server = mon_server['server'];
	var listen = mon_server['listen'];
	var timeS = mon_server['timeS'];

	var mon = createMon();

	mon['server'] = server;
	mon['listen'] = listen;
	mon['timeE'] = timeS;
	return mon;
}

/**
 * Composes the flexible info part of data NOTE: this part is very specific and depends on possible server requests
 * 
 * @param request
 *            {Object} the HTTP(S) request object that holds a required information
 * @param collect_all
 *            {boolean} true value indicates to collecting all possible information
 * @returns the composed flexible info object
 */
function getRequestInfo(request, collect_all) {
	var tmp = createMon();
	var value = request.headers['mon-platform'];
	if (value && value.length > 0) {
		tmp.info.add('platform', value);
	}
	value = request.headers['mon-version'];
	if (value && value.length > 0) {
		tmp.info.add('version', value);
	}
	if (collect_all) {
		value = request.headers['mon-email'];
		if (value && value.length > 0) {
			tmp.info.add('email', value);
		}
		value = request.headers['mon-aname'];
		if (value && value.length > 0) {
			tmp.info.add('aname', value);
		}
        value = 0;
        try {
            value = request.headers['x-forwarded-for']
                || request.connection.remoteAddress
                || request.socket.remoteAddress
				|| request.connection.socket.remoteAddress
                || 0;
        } catch(e) {
            // just leave value = 0
        }
		if (value && value.length > 0) {
			tmp.info.add('access_from', value);
		}
	}
	return tmp.info;
}

/**
 * 
 * @param request
 * @returns OBJECT with user info
 */
function getUserInfo(request, collect_all) {
	if (collect_all) {
		var tmp = {};
		// logger.info("\nRequest\n"+sys.inspect(request));
        var value = 0;
        try {
            var value = request.headers['x-forwarded-for']
                || request.connection.remoteAddress
                || request.socket.remoteAddress
                || request.connection.socket.remoteAddress;
        } catch(e) {
            // just leave value = 0
        }
		if (value && value.length > 0) {
			tmp['ip'] = value;
		}
		value = request.headers['host'];
		if (value && value.length > 0) {
			tmp['host'] = value;
		}
	return tmp;
	}
}

/**
 * Main Monitor class
 * 
 * It only should be initiated when given server wants to be under monitoring *
 * 
 * @param server
 *            {Object} to be under monitoring
 * @param options
 *            {Object} see addToMonitors method comments
 */
var Monitor = exports.addMonitoring = function(server, options) {
	var mon_server = addToMonitors(server, options);
	if (mon_server && mon_server != null) {
//		var host = server.address()['address'] || 'localhost';
//		var port = server.address()['port'] || "??";

		// listener for requests
		server.on('request', function(req, res) {

			req.setMaxListeners(0);
			// logger.info("\nRequest\n"+sys.inspect(req));

			var params = {};
			params['timeS'] = new Date().getTime();//
			params['pathname'] = utils.cleanURL(url.parse(req.url).pathname).trim().toLowerCase();
//			params['Host'] = /* host + ":" + */port;
			// params['Scheme'] = "HTTP";
			params['Method'] = req.method;
			params["content-length"] = req.headers['content-length'];
			params['info'] = getRequestInfo(req, mon_server['collect_all']);
			params['user'] = getUserInfo(req, mon_server['collect_all']);

			// params['memory'] = sys.inspect(process.memoryUsage());
			// params['free'] = os.freemem()/os.totalmem()*100;
			// params['cpu'] = sys.inspect(os.cpus());

			// logger.debug("***Request0: "+JSON.stringify(params, true,2));

			req.on('add_data', function(obj) {
				// logger.info("********req.on event*********** "+JSON.stringify(obj));
				params['net_time'] = obj['net_time'] || 0;
			})

			req.on('end', function() {
				var net_time = new Date().getTime();
				//logger.info("********req.on end*********** " + (net_time - params['timeS']));
				params['net_time'] = net_time;
			})

			var socket = req.socket;
			var csocket = req.connection.socket;
			// listener for response finishing
			if (req.socket) {
				
				req.socket.setMaxListeners(0);
				
				req.socket.on('error', function(err) {
                    console.error("******SOCKET.ERROR****** " + err + " - " + (new Date().getTime() - params['timeS']));
				})
				req.socket.on('close', function() {
					params['timeE'] = new Date().getTime();
					params['pure_duration'] = (params['timeE'] - (params['net_time'] || params['timeE']));
					params['net_duration'] = ((params['net_time'] || params['timeE']) - params['timeS']);
					params['total_duration'] = (params['timeE'] - params['timeS']);

					try {
						params['Read'] = socket.bytesRead || csocket.bytesRead;
					} catch (err) {
						params['Read'] = 0;
					}
					try {
						params['Written'] = socket.bytesWritten || csocket.bytesWritten;
					} catch (err) {
						params['Written'] = 0;
					}
					try {
						params['Status'] = res.statusCode;
					} catch (err) {
						params['Status'] = 0;
					}
					params['Uptime'] = process.uptime();

					if (params['Written'] == 0) {
						console.error("\"Written\":0 " + JSON.stringify(res['_headers']));
					}
					//logger.info("***SOCKET.CLOSE: " + JSON.stringify(params));
					addResultsToMonitor(server, 1, (req.method == "POST" ? 1 : 0), (req.method == "GET" ? 1 : 0),
							params, res.statusCode, function(error) {
								if (error)
									console.error("SOCKET.CLOSE-addResultsToMonitor: error while add");
							});
				})
			} else {
				res.setMaxListeners(0);
				
				res.on('finish', function() {
					params['timeE'] = new Date().getTime();
					params['pure_duration'] = (params['timeE'] - (params['net_time'] || params['timeE']));
					params['net_duration'] = ((params['net_time'] || params['timeE']) - params['timeS']);
					params['total_duration'] = (params['timeE'] - params['timeS']);

					try {
						params['Read'] = socket.bytesRead || csocket.bytesRead;
					} catch (err) {
						params['Read'] = 0;
					}
					try {
						params['Written'] = socket.bytesWritten || csocket.bytesWritten;
					} catch (err) {
						params['Written'] = 0;
					}
					try {
						params['Status'] = res.statusCode;
					} catch (err) {
						params['Status'] = 0;
					}
					params['Uptime'] = process.uptime();// (timeE - time_start) / 1000;// uptime in sec

					//logger.info("***RES.FINISH: " + JSON.stringify(params));
					addResultsToMonitor(server, 1, (req.method == "POST" ? 1 : 0), (req.method == "GET" ? 1 : 0),
							params['net_duration'], params['pure_duration'], params['total_duration'], params['Read'],
							params['Written'], res.statusCode, params['info'], params['user'], function(error) {
								if (error)
									console.error("RES.FINISH-addResultsToMonitor: error while add");
							});
				});
			}
		});

		// listener for server closing
		server.on('close', function(errno) {
			removeFromMonitor(server);
		})

		events.EventEmitter.call(this);
	}
}

sys.inherits(Monitor, events.EventEmitter);

function checkAccess(access_code) {
	var time_min = (new Date().getTime() / 60000).toFixed(0);
	if (access_code
			&& (access_code == "scalex" || access_code == hash.md5(time_min.toString())
			 || access_code == hash.md5((time_min - 1).toString()) || access_code == hash.md5((time_min + 1).toString()))) {
		return true;
	}
	console.error("Wrong access: Correct access code is " + hash.md5(time_min.toString()));
	return false;
}

function obtainOFD(callback) {
	var df = -1;
	// var cmd_ofd = "lsof -p" + process.pid + " | wc -l";//command to retrieve the count of open file descriptors
	var cmd_ofd = "ls /proc/" + process.pid + "/fd | wc -l";// command to retrieve the count of open file descriptors
	require('child_process').exec(cmd_ofd, function(error, stdout, stderr) {
		df = stdout.replace(/[\s]/g, '');
		if (!error && df.length > 0 && !isNaN(df)) {
			OFD = df;
			// logger.info("The count of OFD is " + df);
		} else {
			// logger.error('OFD exec error: ' + error);
		}

		if (callback)
			return callback();
	});
}

function csv_to_dict(csv) {
    var dict = {};
    var lines = String(csv).split("\n");
    for (var i = 0; i < lines.length; i++) {
        var fields = lines[i].split(",");
        if (fields[0] && fields[1])
            dict[fields[0]] = fields[1];
    }
    return dict;
}

function dict_to_csv(dict) {
    var csv = "";
    for (var key in dict) {
        csv += key + "," + dict[key] + "\n";
    }
    return csv;
}



var fs = require('fs');
var path = require('path');

function mkdirParentSync(dirPath, mode) {  
    try {
        fs.mkdirSync(dirPath, mode);
    } catch (e) {
        if (e && e.errno === 34) {
            mkdirParentSync(path.dirname(dirPath), mode);
            mkdirParentSync(dirPath, mode);
        }
    }
}

function storeMonitorPort(port) {
    var os = require('os');
    var fs = require('fs');
    
    var dir = "/opt/citrix/connector/storage/monitor/nodejs";
    if (os.platform().indexOf("win") !== -1) {
        var childDir = "\\citrix\\connector\\storage\\monitor\\nodejs";
        if (os.arch().indexOf("x64") !== -1) {
            dir = "C:\\Program Files(x86)" + childDir;
        } else {
            dir = "C:\\Program Files" + childDir;
        }
    }
    
    mkdirParentSync(dir);
    var filename = path.join(dir, '.monports')

    //logger.debug("storeMonitorPort, filename: " + filename);
    //filename = "/tmp/monports";
    var ports_obj = {};
    try {
        var ports_data = fs.readFileSync(filename);
        ports_obj = csv_to_dict(ports_data);
    } catch(e) {
        // probably file doesn't exist
        //logger.debug("reading file failed: " + e);
    }
    ports_obj[port] = String(process.pid);
    fs.writeFileSync(filename, dict_to_csv(ports_obj));
}

/**
 * Initialize HTTP Server that is returning the summarized monitored data
 * 
 * The request should have the following form:
 * 
 * http://127.0.0.1:10010/node_monitor?action=getdata&access_code={monitis | <access code>}
 * 
 */
function bind(port) {
    monitor_server = http.createServer(function(req, res) {
        // obtainOFD(function(){
        var pathname = url.parse(req.url, true).pathname.replace("/", "").trim().toLowerCase();
        var query = url.parse(req.url, true).query;
        //logger.debug("query = " + JSON.stringify(query) + "\tpathname = " + pathname);
        if (pathname && pathname == "node_monitor" && query && query['action'] && query['access_code']) {
            var action = query['action'].trim().toLowerCase();
            var access_code = query['access_code'].trim().toLowerCase();
        }
        //logger.debug("access_code = " + access_code + "\taction = " + action);
        var result = "???";
        var code = 200;
        if (checkAccess(access_code)) {
            switch (action) {
            case 'getadata':
                result = getMonitorAllResults(true);
                break;
            case 'getdata':
                result = getMonitorTotalResult(true);
                break;
            default:
                result = "wrong command received";
                code = 400;
            }
            
            // append custom metrics data
            result += getCustomMetrics();

        } else {
            result = "Access denied."
            code = 403;
        }
        //logger.debug("SUM: " + result);

        res.writeHead(200, {
            'Content-Type' : 'text/plain',
            'connection' : 'close'
        });
        res.write(result);
        res.end();
    }).listen(port, HOST_LISTEN);
    storeMonitorPort(port);
    console.log("Scalextreme node.js monitoring initialized, socket: " + HOST_LISTEN + ":" + port);
}
exports.bind = bind;

function addCustomValue(key, value) {
    var ts = new Date().getTime();
    if (!(key in custom_metrics)) {
        custom_metrics[key] = [];
    }
    var sec = Math.floor(ts / 1000);
    var ns = (ts - (sec * 1000)) * 1000000;
    custom_metrics[key].push([value, sec, ns]);
}
exports.addCustomValue = addCustomValue;

/**
 * Gets custom metrics data,
 * format:
 * key:value:sec:ns
 */
function getCustomMetrics() {
    var ret = '';
    for (var key in custom_metrics) {
        values = custom_metrics[key];
        if (values.length > 0) {
            custom_metrics[key] = [];
            for (var i = 0; i < values.length; i++) {
                ret += "nodejs." + key + ":" + values[i][0] + ":"
                    + values[i][1] + ":" + values[i][2] + "\n";
            }
        }
    }
    return ret;
}
