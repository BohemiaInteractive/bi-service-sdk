#!/usr/bin/env node

var childProcess = require('child_process');
var fs           = require('fs');
var path         = require('path');
var _            = require('lodash');
var tmp          = require('tmp');
var yargs        = require('yargs');
var mustache     = require('mustache');
var archiver     = require('archiver');
var jshint       = require('jshint').JSHINT;
var Promise      = require('bluebird');

var builder = {
    /**
     *
     */
    main: function main(argv) {
        var self     = this;
        var package  = require(argv.s + '/package.json');
        var specs    = self.getSwaggerSpecs(argv.s, argv.e, argv._);
        var tmpDir   = tmp.dirSync();
        var packages = [];

        Object.keys(specs).forEach(function(appName) {
            var files = [];
            var subdir = `${tmpDir.name}/${package.name}-${appName}-${package.version}`;
            var outputFileName = subdir + '.zip';
            var buildedPackage = {dir: subdir, files: files};

            packages.push(buildedPackage);
            fs.mkdirSync(subdir);
            fs.mkdirSync(subdir + '/tests');

            //var output = fs.createWriteStream(process.cwd() + outputFileName, {
                //flags: 'wx' //dont overwrite
            //});

            var sdkIndex = self.renderTemplate('index', {
                versions: Object.keys(specs[appName])
            });
            var sdkPackage = self.renderTemplate('package',
                _.merge({appName: appName}, package));

            self.lintSource(sdkIndex);
            self.lintSource(sdkPackage);

            fs.writeFileSync(subdir + '/index.js', sdkIndex);
            fs.writeFileSync(subdir + '/package.json', sdkPackage);

            Object.keys(specs[appName]).forEach(function(version) {

                var spec = specs[appName][version];
                var context = self.getTemplateContext(spec, package);
                context.context = JSON.stringify(context);
                var sdkModule = self.renderTemplate('module', context);
                var sdkTests = self.renderTemplate('test', context);

                self.lintSource(sdkModule);
                fs.writeFileSync(subdir + `/${version}.js`, sdkModule);
                fs.writeFileSync(subdir + `/tests/${version}.js`, sdkTests);
                //files.push({
                    //data: fs.createReadSteam(subdir + `/${version}.js`)
                //});
            });
        });

        return Promise.each(packages, function(package) {
            return self.runNpmInstall(package.dir).then(function() {
                self.runPackageTests(package.dir);
            }).catch(function(err) {
                console.error(err.message);
                process.exit(1);
            });
        });
    },

    zipFiles: function zipFiles(files, writeStream) {
        files = files || [];

        var archive  = archiver('zip', { zlib: { level: 9 } });
        files.forEach(function(file) {
            archive.append(file.data, file.opt);
        });

        return  new Promise(function(resolve, reject){
            writeStream.once("close", resolve);
            writeStream.once("error", reject);
            archive.pipe(writeStream);
            archive.finalize();
        });
    },

    runNpmInstall: function runNpmInstall(projectRoot) {

        var proc = childProcess.spawn('npm', [
            'install',
            'bluebird',
            'bi-service-sdk'
        ], {cwd: projectRoot});

        return new Promise(function(resolve, reject) {
            var stderr = '';
            proc.stderr.on('data', function(data) {
                stderr += data.toString();
            });
            proc.on('close', function(code) {
                if (code !== 0) {
                    return reject(new Error(stderr));
                }

                return resolve();
            });
        });
    },

    runPackageTests: function runPackageTests(projectRoot) {
        var proc = childProcess.spawn('mocha',
            ['--ui', 'bdd', '--colors', '--check-leaks', '-t', '5000',
                '--reporter', 'spec', "tests/**/*.js"],
            {cwd: projectRoot}
        );

        return new Promise(function(resolve, reject) {
            var stderr = '';
            var stdout = '';

            proc.stdout.on('data', function(data) {
                stdout += data.toString();
            });

            proc.stderr.on('data', function(data) {
                stderr += data.toString();
            });
            proc.on('close', function(code) {
                if (code !== 0) {
                    return reject(new Error(stderr));
                }

                return resolve(stdout);
            });
        });
    },

    /**
     *
     * @param {String} source
     * @throws {Error}
     * @return {undefined}
     */
    lintSource: function lintSource(source) {

        var JSHINT_OPTIONS = {
            node      : 'node',
            undef     : true,
            strict    : true,
            trailing  : true,
            smarttabs : true,
            maxerr    : 999
        };

        if(!jshint(source, JSHINT_OPTIONS, {Promise: true})){
            jshint.errors.forEach(function(error) {
                throw new Error(error.reason + ' in ' + error.evidence + ' (' + error.code + ')');
            });
        };
    },

    /**
     * @public
     *
     * @param {Object} spec - swagger 2.0 definition
     * @param {Object} package - service's package.json
     *
     * @return {Object}
     */
    getTemplateContext: function getTemplateContext(spec, package) {
        var self = this;
        var out = {
            moduleName : this.getConstructorName(package.name, spec.info.version),
            openbrace  : '{',
            closebrace : '}',
            version    : spec.info.version,
            host       : (spec.schemes.indexOf('https') !== -1 ? 'https://' : 'http://') + spec.host,
            basePath   : spec.basePath,
            paths      : []
        };

        var _sdkMethodNames = [];

        Object.keys(spec.paths).forEach(function(path) {
            Object.keys(spec.paths[path]).forEach(function(method) {
                var route = spec.paths[path][method];

                var def = {
                    sdkMethodName : route.sdkMethodName,
                    hasBody       : ~['post', 'put', 'delete'].indexOf(method.toLowerCase()),
                    operationId   : route.operationId,
                    tags          : route.tags,
                    routeDesc     : (route.description || '').replace(/\ {2,}/g, ' '),
                    summary       : route.summary,
                    method        : method,
                    url           : path,
                    pathParams    : self.filterParams(route.parameters, 'path'),
                    queryParams   : self.filterParams(route.parameters, 'query'),
                    headerParams  : self.filterParams(route.parameters, 'header'),
                    bodyParams    : self.filterParams(route.parameters, 'body|formData'),
                    methodPathArgs: function() {
                        return this.pathParams.map(function(param) {
                            return param.name;
                        }).join(', ') + (this.pathParams.length ? ', ': '');
                    }
                };

                //convert body payload to formData-like format and strip parameters
                //to one level deep definitions
                if (def.bodyParams.length == 1 && def.bodyParams[0].in === 'body') {
                    def.bodyParams = self.body2Params(def.bodyParams[0]);
                }

                if (~_sdkMethodNames.indexOf(route.sdkMethodName)) {
                    throw new Error(`Duplicate route sdk method name: ${route.sdkMethodName}`);
                }

                _sdkMethodNames.push(route.sdkMethodName);
                out.paths.push(def);
            });
        });

        return out;
    },

    /**
     *
     * @param {String} serviceName
     * @param {String} version
     *
     * @return {String}
     */
    getConstructorName: function getConstructorName(serviceName, version) {
        serviceName = serviceName.replace(/^bi-/, '');
        serviceName = serviceName.toLowerCase();
        serviceName = serviceName.charAt(0).toUpperCase() + serviceName.slice(1);
        version = version.replace(/\./, '_');

        return `${serviceName}SDK_${version}`;
    },

    /**
     * @param {String} template
     * @param {Object} context
     *
     * @return {String}
     */
    renderTemplate: function renderTemplate(template, context) {

        var tmpl = fs.readFileSync(
            path.resolve(__dirname + `/../lib/templates/${template}.mustache`)
        );

        return mustache.render(tmpl.toString(), context);
    },

    /**
     * @param {Array} params
     * @param {String} filter - type of parameters to return
     * @return {Array}
     */
    filterParams: function filterParams(params, filter) {
        return params.filter(function(param) {
            return param.in.match(filter);
        });
    },

    /**
     * @param {Object} body
     * @param {Array} out - internal property
     *
     * @return {Array}
     */
    body2Params: function body2Params(body, out) {
        out = out || [];

        Object.keys(body.schema.properties).forEach(function(name) {
            var required = body.schema.required;
            var param = body.schema.properties[name];

            out.push({
                name: name,
                required: Array.isArray(required) && required.indexOf(name) !== -1,
                in: 'formData',
                type: param.type,
                format: param.format,
                description: param.description
            });
        });

        return out;
    },

    /**
     * @param {String} projectRoot - dirrectory of bi-service based project
     * @param {String} executable - filepath to bi-service-doc executable
     * @param {String} execArgs - shell arguments provided to the bi-service-doc
     *
     * @throws Error
     * @return {Object}
     */
    getSwaggerSpecs: function getSwaggerSpecs(projectRoot, executable, execArgs, _attempt) {
        _attempt = _attempt || 0;
        args = _.clone(execArgs);
        args.unshift('get:swagger');
        args.unshift(executable);

        if (!~args.indexOf('-f') && !~args.indexOf('--file')) {
            args.push('--file');
            args.push(projectRoot + (_attempt ? '/index.js' : '/lib/app.js'));
        }

        if (!~args.indexOf('--config')) {
            args.push('--config');
            args.push(projectRoot + '/config/development/config.json5');
        }

        var result = childProcess.spawnSync('node', args);

        if (result.error) {
            throw result.error;
        }

        //invalid --file option is provided
        if (~[66, 65].indexOf(result.status)) {
            return this.getSwaggerSpecs.call(this, projectRoot, executable, execArgs, ++_attempt);
        } else if (result.status !== 0) {
            throw new Error(result.stderr.toString());
        }

        try {
            var specs = JSON.parse(result.stdout.toString());
        } catch(e) {
            throw new Error('Failed to parse swagger JSON specs: ' + e.message);
        }

        return specs;
    }

};

module.exports = Object.create(builder);

if (module.parent === null) {

    var argv = yargs
    .usage('$0 --service [path] --doc-exec [path] -- [bi-service-doc-args]')
    .option('service', {
        alias: 's',
        describe: 'Filesystem path to root project directory',
        required: true,
        default: process.cwd(),
        coerce: path.resolve,
        type: 'string'
    })
    .option('doc-exec', {
        alias: 'e',
        describe: 'bi-service-doc executable.',
        default: 'bi-service-doc',
        required: true,
        coerce: path.resolve,
        type: 'string'
    })
    .example('$0 -s $PROJECTS/bi-depot -- --app public',
        'Generates client sdk npm package for given app(s)')
    .help('h', false).argv;

    return module.exports.main(argv);
}
