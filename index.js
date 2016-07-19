'use strict';

require('es6-shim');

var machina = require('machina');
var exec = require('child_process').exec; // Use exec only for little commands

var PacketReader = require('./packet-reader');


function execPromise(command, callback) {

    if (!callback)
        callback = function (error) {
            return error;
        };

    return new Promise(function (resolve, reject) {
        exec(command, function (err, stdout, stderr) {
            var result = callback(err, stdout, stderr);
            // Swallow error if the callback returns undefined
            if (err && result !== undefined)
                reject(result);
            else
                resolve(result);
        });
    });
}


function createFsmWifi () {

    var anonymousInterval;

    var fsm = new machina.Fsm({

        initialState: "sleeping",

        myInterface: 'wlan0',
        recordInterval: null,
        instantMap: {},
        recordTrajectories: true,
        packetReader: null,

        initialize: function(){
            if (this.packetReader) {
                this.sleep();
                this.packetReader.stop();
            }

            this.packetReader = new PacketReader();

            this.packetReader.on('error', function (err) {
                console.log(err);
            });
        },

        states: {
            "sleeping": {

                _onEnter: function() {
                    console.log('============== ' + this.state + ' ==============');
                },

                changeInterface: function(newInterface) {
                    if (newInterface)
                        this.myInterface = newInterface;
                    this.handle('initialize');
                },

                wakeUp: function(){
                    var self = this;

                    enterMonitorMode(this.myInterface)
                    .then(function(){
                        self.transition('monitoring');
                    })
                    .catch(function(err){
                        self.clearQueue('monitoring'); // Clear the possible deferUntilTransition event
                        console.log('err', err, err.stack);
                        console.log('Couldn\'t enter Monitor mode... Going back to sleep.');
                        exitMonitorMode(self.myInterface);
                    });
                },

                record: function(){
                    this.deferUntilTransition('monitoring');
                    this.handle('wakeUp');
                },

                _onExit: function(){
                    console.log('Exiting sleeping state');
                }

            },

            "monitoring": {

                _onEnter: function(){
                    console.log('============== ' + this.state + ' ==============');
                },

                tryToSleep: function(){
                    var self = this;

                    exitMonitorMode(self.myInterface)
                    .then(function(){
                        console.log('Monitor mode deactivated');
                        self.transition('sleeping');
                    })
                    .catch(function(err){
                        console.log('err', err, err.stack);
                        console.log('Couldn\'t exit Monitor mode, still monitoring');
                    });
                },

                record: function(period){
                    var self = this;

                    startRecording(period)
                    .then(function(){
                        self.transition('recording');
                    })
                    .catch(function(err){
                        console.log('err', err, err.stack);
                        console.log('Couldn\'t enter Recording mode, still monitoring');
                    });
                },

                _onExit: function(){
                    console.log('Exiting monitoring state');
                }
            },

            "recording": {

                _onEnter: function(){

                    console.log('============== ' + this.state + ' ==============');
                },

                tryToSleep: function(){
                    this.deferUntilTransition('monitoring');
                    this.handle('pause');
                },

                pause: function(){
                    var self = this;

                    console.log('pausing');
                    stopRecording(this.process)
                    .then(function(){
                        self.transition('monitoring');
                    })
                    .catch(function(err){
                        self.clearQueue('monitoring'); // Clear the possible deferUntilTransition event
                        console.log('err', err, err.stack);
                        console.log('Couldn\'t exit Recording mode, still monitoring');
                    });
                },

                _onExit: function(){
                    console.log('Exiting recording state');
                }
            }
        },

        wakeUp: function(){
            this.handle('wakeUp');
        },

        sleep: function(){
            this.handle('tryToSleep');
        },

        record: function(period){
            this.handle('record', period);
        },

        pause: function(){
            this.handle('pause');
        }
    });

    function enterMonitorMode(myInterface) {
        // this spawns the iw process whose purpose is to set the wifi card in monitor mode
        return new Promise(function(resolve, reject) {

            console.log('Activating Monitor mode... interface :', myInterface);
            var physicalInterface;

            // Get the physical interface
            return execPromise('((iw dev | head -n 1 | sed s/#// | grep phy) || (iw phy | head -n 1 | sed "s/Wiphy //" | grep phy))',
            function (error, stdout, stderr) {
                if (error) {
                    reject(stderr.toString());
                    return stderr.toString();
                }
                else {
                    physicalInterface = stdout.toString().replace('\n', '');
                    console.log('physical interface to use :', physicalInterface);
                    if (!physicalInterface)
                        reject("Invalid interface");
                }
            })
            .then(function () {
            // Create a monitor interface on the physical interface
                return execPromise('iw phy ' + physicalInterface + ' interface add ' + myInterface + 'mon type monitor', function (error, stdout, stderr) {
                    if (error && error.code !== 233) { // Error code 233 === Already in monitor mode
                        reject(stderr.toString());
                        return stderr.toString();
                    }
                    else
                        return undefined;
                });
            })
            .then(function () {
            // Activate the monitor interface
                return execPromise('ifconfig ' + myInterface + 'mon up', function (error, stdout, stderr) {
                    if (error) {
                        reject(stderr.toString());
                        return stderr.toString();
                    }
                });
            })
            .then(function () {
            // Delete the old interface
                return execPromise('iw dev '+ myInterface + ' del', function () {
                    // Not an important error, swallow it.
                    return undefined;
                });
            })
            .then(resolve)
            .catch(function (err) {
                console.log('error while entering monitor mode :', err);
                reject(err);
            });
        });
    }

    function exitMonitorMode(myInterface) {

        return new Promise(function(resolve, reject){
            console.log("Deactivating Monitor mode... " + myInterface);

            var physicalInterface = 'phy0';

            // Get the physical interface
            return execPromise('((iw dev | head -n 1 | sed s/#// | grep phy) || (iw phy | head -n 1 | sed "s/Wiphy //" | grep phy))',
                function (error, stdout, stderr) {
                if (error) {
                    reject(stderr.toString());
                    return stderr.toString();
                }
                else {
                    physicalInterface = stdout.toString().replace('\n', '');
                    if (!physicalInterface)
                        reject("Invalid interface");
                }
            })
            .then(function () {
            // Re-add the initial interface
                return execPromise('iw phy ' + physicalInterface + ' interface add ' + myInterface + ' type managed',
                    function (error, stdout, stderr) {
                    if (error) {
                        reject(stderr.toString());
                        return stderr.toString();
                    }
                });
            })
            .then(function () {
            // End monitoring mode
                return execPromise('iw dev ' + myInterface + 'mon' + ' del', function (error, stdout, stderr) {
                    if (error) {
                        reject(stderr.toString());
                        return stderr.toString();
                    }
                });
            })
            .then(function () {
            // Re-up the initial interface
                execPromise('ifconfig ' + myInterface + ' up', function() {
                    // Not an important error, swallow it.
                    return undefined;
                });
            })
            .then(resolve)
            .catch(function (err) {
                console.log('error while exiting monitor mode :', err);
                reject(err);
            });

        });
    }



    function startRecording(period){
        console.log('Starting recording process...');

        // start recording
        return new Promise(function(resolve, reject) {

            try {
                fsm.packetReader.start(fsm.myInterface + 'mon');
            } catch(err) {
                reject(err);
            }

            // packetReader listener
            fsm.packetReader.on('packet', function (packet) {
                if (packet.type === 'Probe Request' || packet.type === 'other') {
                    console.log("==> ", packet.mac_address, " : ", packet.signal_strength)
                }
            });

            // the packetReader throws an error at startup. in order to say that it's recording.
            // We listen to it and resolve when this "error" appears.
            fsm.packetReader.once('error', function(){
                resolve();
            });

            // on timeout, reject Promise
            setTimeout(function(){
                fsm.emit('recordError', 'timeout');
                reject(new Error("Timeout"));
            }, QUERY_TIMEOUT);
        });
    }

    function stopRecording(){
        console.log('Stopping recording...');

        return new Promise(function(resolve) {

            if (fsm.recordInterval)
                clearInterval(fsm.recordInterval);

            if (fsm.packetReader) {
                fsm.packetReader.removeAllListeners('packet');
                fsm.packetReader.stop();
            }
            resolve();
        });
    }

    return fsm;
}

var dongle = createFsmWifi();
dongle.record(60);
