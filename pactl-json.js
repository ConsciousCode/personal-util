'use strict';

const
	{execSync} = require("child_process");

function parseVolume(v) {
	// Raw-volume / Percent% / loudness dB
	let m = /^(\d+)\s*\/\s*(\d+)\s*%?\s*\/\s*(\S+)\s*db$/i.exec(v);
	return {
		raw: m[1]|0,
		value: m[2]/100,
		// Decibel is a float value
		decibel: +m[3]
	};
}

function parseSecond(s) {
	return {
		m: 0.001,
		u: 0.000001,
		n: 0.000000001
	}[s] || 1;
}

function parseFreq(f) {
	return {
		g: 1000000000,
		m: 1000000,
		k: 1000
	}[f] || 1;
}

function processPropertiesHeader(v) {
	let props = {};
	
	for(let k in v) {
		let cur = props, path = k.split(/\./g), last = path.pop();
		for(let p of path) {
			if(!(p in props)) {
				props[p] = {};
			}
			
			cur = props[p];
		}
		
		let m = /^"(.+?)"$/.exec(v[k]), content = m? m[1] : v[k], val;
		
		switch(k) {
			// Properties to parse as integers
			case "alsa.resolution_bits":
			case "alsa.subdevice":
			case "alsa.device":
			case "alsa.card":
			case "device.buffering.buffer_size":
			case "device.buffering.fragment_size":
				val = content|0;
				break;
			
			// Boolean
			case "module-udev-detect.discovered":
				val = !!(content|0);
				break;
			
			// Everything else is a normal string
			default:
				val = content;
				break;
		}
		
		cur[last] = val;
	}
	
	return props;
}

function processPortsHeader(v) {
	let props = {};
	for(let k in v) {
		let m = /(\S+)\s*\(priority:\s(\d+)(, not available)?\)/.exec(v[k]);
		
		props[k] = {
			name: m[1],
			priority: m[2]|0,
			available: !!m[3]
		};
	}
	
	return props;
}

function processFormatsHeader(v) {
	console.log("Processing", v);
	return Object.values(v);
}

/**
 * Separate function for processing properties, because pactl doesn't
 *  use a consistent format.
**/
function processProps(oldprops) {
	let props = {};
	
	for(let prop in oldprops) {
		let lkey = prop.toLowerCase(), val;
		if(typeof oldprops[prop] === 'object') {
			let v = oldprops[prop];
			switch(lkey) {
				case "properties":
					val = processPropertiesHeader(v);
					break;
				
				case "ports":
					val = processPortsHeader(v);
					break;
				
				case "formats":
					val = processFormatsHeader(v);
					break;
			}
		}
		else {
			let content = oldprops[prop].trim();
			
			switch(lkey) {
				// Properties that don't need special parsing
				case "state":
				case "name":
				case "description":
				case "driver":
				case "monitor source":
				case "active port":
					val = content;
					break;
				
				// The rest need special parsing
				
				case "sample specification":
					// Format channels frequency
					let ss = /^(\S+)\s*(\d+)(?:\S+)?\s*(\S+)$/.exec(content);
					let f = /(\d+)(?:([gmk])?hz)?/i.exec(ss[3]);
					val = {
						format: ss[1],
						channels: ss[2],
						frequency: f[1]*parseFreq(f[2])
					};
					break;
				
				case "channel map":
					val = content.split(/\s*,\s*/);
					break;
				
				case "owner module":
					val = content|0;
					break;
				
				case "mute":
					val = {
						yes: true,
						no: false
					}[content.toLowerCase()];
					break;
				
				case "volume":
					let data = /^(.+?)(?:\s*balance\s(.+?))?$/i.exec(content);
					
					val = {};
					for(let d of data[1].split(/\s*,\s*/g)) {
						let [k, v] = d.split(/\s*:\s*/g);
						val[k] = parseVolume(v);
					}
					
					if(data[2]) {
						val.balance = +data[2];
					}
					break;
				
				case "base volume":
					val = parseVolume(content);
					break;
				
				case "latency":
					let m = new RegExp(
						String.raw`(\d+)\s*(?:(.*)sec)?\s*,\s*` +
						String.raw`configured\s*(\d+)\s*(?:(.*)sec)?`, 'i'
					).exec(content);
					val = {
						current: m[1]*parseSecond(m[2]),
						configured: m[3]*parseSecond(m[4])
					}
					break;
				
				case "flags":
					val = content.split(/\s+/g);
					break;
			}
		}
		
		let key = {
			"sample specification": "sampling",
			"channel map": "channels",
			"owner module": "ownerModule",
			"base volume": "baseVolume",
			"monitor source": "monitorSource",
			"active port": "activePort",
			
			// Nicer name, eg property.alsa.id
			"properties": "property"
		}[lkey] || lkey;
		
		props[key] = val;
	}
	
	return props;
}

class Parser {
	constructor(src) {
		this.lines = src.split(/\r?\n/g);
		this.line = 0;
	}
	
	parseProps(section, indent) {
		let props = {}, last, m;
		
		if(this.line >= this.lines.length) {
			return null;
		}
		
		for(; this.line < this.lines.length; ++this.line) {
			let line = this.lines[this.line];
			
			m = /^\t+/.exec(line);
			if(!m || m[0].length < indent) {
				break;
			}
			
			// Leaves are (mostly) self-contained properties
			m = /^(\t*)(\S+?)\s*[:=]\s*(.+?)\s*$/.exec(line);
			if(m) {
				last = m[2];
				props[last] = m[3];
				continue;
			}
			
			// Heads indicate a section of related properties
			m = /^(\t*)(\S+?)\s*[:=]\s*$/.exec(line);
			if(m) {
				++this.line;
				
				last = m[2];
				props[last] = this.parseProps(last, m[1].length + 1);
				--this.line;
				continue;
			}
			
			// pactl wraps at 80 characters, so this combines anything
			//  that wrapped to the next line.
			m = /^(\t*)(\S+?)\s*$/.exec(line);
			if(m) {
				if(m[1].length == indent + 1) {
					props[last] += ' ' + m[2];
				}
				// Only used in Formats, oddball inconsistent syntax
				else {
					props[m[2]] = m[2];
				}
			}
		}
		
		// Now that all the properties are parsed, go over and
		//  normalize them.
		return props;
	}
	
	parseSink() {
		++this.line; // skip the line, "Sink #<n>"
		let s = this.parseProps("sink", 1);
		++this.line; // skip empty line
		
		return s? processProps(s) : null;
	}
	
	parse() {
		let sink, sinks = [];
		while(sink = this.parseSink()) {
			sinks.push(sink);
		}
		
		return sinks;
	}
}

function parse(s) {
	return new Parser(s).parse();
}

function grab() {
	return parse(execSync("pactl list sinks") + "");
}

module.exports = {
	Parser, parse, grab
}
