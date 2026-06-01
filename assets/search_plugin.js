const fs = require('fs');
const data = JSON.parse(fs.readFileSync('c:/Users/temp/Lithic_Dev/Lithic/assets/__plugins_linonetwo_tw-whiteboard.json', 'utf8'));

// TiddlyWiki JSON plugin format
let tiddlers;
if (Array.isArray(data)) {
    tiddlers = JSON.parse(data[0].text).tiddlers;
} else if (data.tiddlers) {
    tiddlers = JSON.parse(data.tiddlers['$:/plugins/linonetwo/tw-whiteboard'].text);
}

Object.keys(tiddlers).forEach(k => {
    const text = tiddlers[k].text;
    if (text) {
        if (text.includes('Keep Style Menu Open') || text.includes('Keep Open')) {
            console.log('Found Keep Open in:', k);
        }
    }
});
