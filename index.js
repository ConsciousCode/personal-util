'use strict';

const
	fs = require("fs"),
	path = require("path"),
	{execSync} = require("child_p");

function cacheval(name, fn) {
	let v = fn.call(this);
	delete this[name];
	return this[name] = v;
}

function cachefile(name, fname) {
	return cacheval(name, () => {
		return fs.readFileSync(fname);
	});
}

/**
 * Cache for values we don't want to constantly recalculate
**/
let cache = {
	backlight: {
		get path: cacheval('path', () => {
			const PRE = "/sys/class/backlight";
			return path.join(PRE, fs.readdirSync(PRE)[0]);
		}),
		get max: cacheval('max', () => {
			return fs.readFileSync(
				path.join(this.path, "max_brightness")
			);
		})
	},
	audio: {
		get sinks: cacheval('sinks', () => {
			let ls = exec("pactl list short sinks").split(/\r?\n/g);
			for(let sink of ls) {
				// id name driver format channels samprate status
				let m = /^(\d+)\s+(\S+).+?RUNNING$/.exec(sink);
				if(m) {
					return m[1]|0;
				}
			}
			
			// Just return something if we can
			if(ls.length) {
				return 0;
			}
			
			throw new Error("No audio sink");
		})
	}
}

module.exports = {
	cache,
	get brightness: () => {
		let v = fs.readFileSync(
			path.join(cache.backlight.path, "brightness")
		);
		
		return v/cache.backlight.max;
	},
	get volume: () => {
		
	}
}
