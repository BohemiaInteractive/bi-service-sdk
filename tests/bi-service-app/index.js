/**
 * this file represents bi-service based app
 * and its purpose is to help test the bin/bi-service-doc
 * shell executable
 */

var Service = require('bi-service');
var config = require('bi-config');

var service = module.exports = new Service(config);

service.on('set-up', function() {
    //app1
    this.buildApp('app1', {validator: {definitions: {}}}).buildRouter({
        url: '/',
        version: 1
    }).buildRoute({
        url: '/',
        type: 'get'
    }).validate({
        id: {$is: Number}
    }, 'query');

});

//app2
service.buildApp('app2', {validator: {definitions: {}}}).buildRouter({
    url: '/',
    version: 2
}).buildRoute({
    url: '/:id',
    type: 'put'
}).validate({
    id: {$is: Number}
}, 'params');
