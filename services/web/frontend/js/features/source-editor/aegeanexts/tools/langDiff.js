// 对比英文-中文翻译文件的缺失项，并列举出来

// cd to current directory and run this file in node.js
// node langDiff.js

var fs = require('fs');
function loadLangConfig(localeFilePath) {
    // read locale file and return a map
    var localeContent = fs.readFileSync(localeFilePath, 'utf8');
    return JSON.parse(localeContent);
}

function compareLangs(enLocaleFilePath, zhLocaleFilePath) {
    var enLocale = loadLangConfig(enLocaleFilePath);
    var zhLocale = loadLangConfig(zhLocaleFilePath);
    var missingPairs = {};
    for (var key in enLocale) {
        if (!zhLocale[key]) {
            missingPairs[key] = enLocale[key];
        }
    }
    return missingPairs;
}

var enLocaleFilePath = "/overleaf/services/web/locales/en.json";
var zhLocaleFilePath = "/overleaf/services/web/locales/zh-CN.json";

var missingPairs = compareLangs(enLocaleFilePath, zhLocaleFilePath);
console.log(missingPairs);
// calculate the number of missing items
console.log('miss keys count of chinese language resource: ' + Object.keys(missingPairs).length);