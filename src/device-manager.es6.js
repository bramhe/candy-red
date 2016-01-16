'use strict';

import 'source-map-support/register';
import os from 'os';
import fs from 'fs';
import readline from 'readline';
import { EventEmitter } from 'events';
import Promise from 'es6-promises';
import cproc from 'child_process';
import crypto from 'crypto';
import path from 'path';

const REBOOT_DELAY_MS = 1000;
const TRACE = process.env.DEBUG || false;

export class DeviceIdResolver {
  constructor(RED) {
    this.RED = RED;
    this.flowFileSignature = '';
    this.hearbeatIntervalMs = -1;
    this.ciotSupported = false;
  }

  resolve() {
    return new Promise((resolve, reject) => {
      return this._resolveCANDYIoT(resolve, reject);
    });    
  }
  
  _resolveCANDYIoT(resolve, reject) {
    // CANDY IoT
    // TODO
    return this._resolveEdison(resolve, reject);
  }

  _resolveEdison(resolve, reject) {
    // Intel Edison Yocto
    fs.stat('/factory/serial_number', err => {
      if (err) {
        return this._resolveLTEPi(resolve, reject);
      }
      fs.read('/factory/serial_number', (err, data) => {
        if (err) {
          return reject(err);
        }
        resolve('EDN:' + data);
      });
    });
  }
  
  _resolveLTEPi(resolve, reject) {
    // LTE Pi
    // TODO
    return this._resolveRPi(resolve, reject);
  }
  
  _resolveRPi(resolve, reject) {
    // RPi
    fs.stat('/proc/cpuinfo', err => {
      if (err) {
        return this._resolveMAC(resolve, reject);
      }
      let reader = readline.createInterface({
        input: fs.createReadStream('/proc/cpuinfo')
      });
      let id = '';
      reader.on('line', line => {
        if (line.indexOf('Serial ') >= 0 && line.indexOf(':') >= 0) {
          id = line.split(':')[1].trim();
        }
      });
      reader.on('close', err => {
        if (err || !id) {
          return this._resolveMAC(resolve, reject);
        }
        resolve('RPi:' + id);
      });
    });
  }

  _resolveMAC(resolve, reject) {
    let ifs = os.networkInterfaces();
    for (let key in ifs) {
      if (ifs.hasOwnProperty(key)) {
        for (let i in ifs[key]) {
          let mac = ifs[key][i].mac;
          if (mac && mac !== '00:00:00:00:00:00') {
            return resolve('MAC:' + key + ':' + mac.replace(new RegExp(':', 'g'), '-').toLowerCase());
          }
        }
      }
    }
    reject(new Error('No identifier!'));
  }
}

export class DeviceManager {
  constructor(RED) {
    this.RED = RED;
    this.listenerConfig = null;
    this.events = new EventEmitter();
    this.resolver = new DeviceIdResolver(RED);
    this._reset();
  }

  isWsClientInitialized() {
    return this.listenerConfig !== null;
  }

  initWsClient(account, accountConfig, webSocketListeners) {
    this.resolver.resolve().then(id => {
      this._initWsClient(id, account, accountConfig, webSocketListeners);
    });
  }
  
  _reset() {
    this.cmdIdx = 0;
    this.commands = {};
    this.enrolled = false;
  }

  _initWsClient(id, account, accountConfig, webSocketListeners) {
    this.listenerConfig = webSocketListeners.get({
      accountConfig: accountConfig,
      account: account,
      path: 'candy-ws'
    }, {
      headers: {
        'x-acc-fqn': accountConfig.accountFqn,
        'x-acc-user': accountConfig.loginUser,
        'x-device-id': id,
        'x-hostname': os.hostname(),
        'x-candy-iotv': this.RED.settings.candyIotVersion,
        'x-candy-redv': this.RED.settings.candyRedVersion,
      }
    });
    accountConfig.on('close', () => {
      this.listenerConfig.close();
    });
    let prefix = '[CANDY RED] {DeviceManager}:[' + accountConfig.accountFqn + '] ';
    this.events.on('opened', () => {
      this.RED.log.warn(prefix + 'connected');
    });
    this.events.on('closed', () => {
      this.RED.log.warn(prefix + 'disconnected');
      this._reset();
    });
    this.events.on('erro', () => {
      this.RED.log.warn(prefix + 'error');
      this._reset();
    });
    // receiving an incoming message (sent from a source)
    this.events.send = msg => {
      let payload = msg.payload;
      if (payload) {
        try {
          payload = JSON.parse(payload);
        } catch (_) {
        }
      }
      if (TRACE) {
        this.RED.log.info('[CANDY RED] Received!:' + JSON.stringify(payload));
      }
      if (!this.enrolled) {
        if (!payload || !payload.status || payload.status / 100 !== 2) {
          // Terminate everything and never retry
          this.listenerConfig.close();
          this.RED.log.error('[CANDY RED] Enrollment error!' +
            ' This device is not allowed to access the account:' +
            accountConfig.accountFqn);
          return;
        } else {
          payload = payload.commands;
          this.enrolled = true;
        }
      }
      this._performCommands(payload).then(result => {
        this._sendToServer(result);
      }).catch(result => {
        if (result instanceof Error) {
          let err = result;
          result = {};
          result.status = 500;
          result.message = err.toString();
          result.stack = err.stack;
        } else if (result && !Array.isArray(result)) {
          result = [result];
        }
        this._sendToServer(result);
      }).catch(err => {
        this.RED.log.error(err.stack);
      });
    };
    this.listenerConfig.registerInputNode(this.events);
    this.listenerConfig.send = payload => {
      if ((typeof(payload) === 'object') && !(payload instanceof Buffer)) {
        payload = JSON.stringify(payload);
      }
      return this.listenerConfig.broadcast(payload);
    };
  }
  
  _sendToServer(result) {
    if (!result || Array.isArray(result) && result.length === 0 || Object.keys(result) === 0) {
      // do nothing
      this.RED.log.info('[CANDY RED] No commands to respond to');
      return;
    }
    result = this._numberResponseCommands(result);
    let sent = this.listenerConfig.send(result);
    if (TRACE && sent) {
      this.RED.log.info('[CANDY RED] Sent!:' + JSON.stringify(result));
    }
    if (!Array.isArray(result)) {
      result = [result];
    }
    if (result.reduce((p, c) => {
      return p || (c && c.reboot);
    }, false)) {
      // systemctl shuould restart the service
      setTimeout(() => {
        process.exit(219);
      }, REBOOT_DELAY_MS);
    }
  }
  
  _nextCmdIdx() {
    this.cmdIdx = (this.cmdIdx + 1) % 65536;
    return this.cmdIdx;
  }
  
  _numberResponseCommands(result) {
    let processed = result;
    if (!Array.isArray(result)) {
      processed = [result];
    }
    processed.forEach(r => {
      if (r.commands) {
        if (!Array.isArray(r.commands)) {
          r.commands = [r.commands];
        }
        r.commands.forEach(c => {
          c.id = this._nextCmdIdx();
          this.commands[c.id] = c;
        });
      }
    });
    return result;
  }
  
  _performCommands(commands) {
    if (!commands) {
      return new Promise(resolve => resolve()); // do nothing
    }

    if (Array.isArray(commands)) {
      // same as act:parallel
      let promises = commands.map(c => {
        return this._performCommands(c);
      });
      return Promise.all(promises).then(resultArray => {
        let result = resultArray.reduce((a, b) => {
          if (a && b) {
            return a.concat(b);
          } else if (!a) {
            return b;
          }
          return a;
        }, []);
        return new Promise(resolve => resolve(result));
      });
    }

    if (commands.status) {
      // response to the issued command
      if (commands.id) {
        let c = this.commands[commands.id];
        if (!c) {
          if (commands.status / 100 !== 2) {
            this.RED.log.info(`[CANDY RED] Failed to perform command: ${JSON.stringify(c)}, status:${JSON.stringify(commands)}`);
          }
          delete this.commands[commands.id];
        }
      }
      if (commands.commands) {
        return this._performCommands(commands.commands);
      }
      if (commands.status / 100 !== 2) {
        this.RED.log.info(`[CANDY RED] Server returned error, status:${JSON.stringify(commands)}`);
      }
      return new Promise(resolve => resolve()); // do nothing
    }

    if (!commands.id) {
      return new Promise(resolve => resolve({status:400, message:'id missing'}));
    }
    if (!commands.cat) {
      return new Promise(resolve => resolve({status:400, message:'category missing'}));
    }

    if (commands.cat === 'ctrl') {
      let children = commands.args || [];
      if (!Array.isArray(children)) {
        children = [children];
      }
      let promises;
      switch(commands.act) {
      case 'sequence':
        promises = children.reduce((p, c) => {
          if (!c) {
            return p;
          }
          let next = p.then(result => {
            return this._performCommand(c, result);
          });
          return next;
        }, new Promise(resolve => resolve())).then(result => {
          return new Promise(resolve => {
            if (result) {
              result.push({status:200, id:commands.id});
              return resolve(result);
            }
            return resolve({status:400, id:commands.id});
          });
        });
        return promises;

      case 'parallel':
        promises = children.map(c => {
          return this._performCommands(c);
        });
        return Promise.all(promises).then(resultArray => {
          let result = resultArray.reduce((a, b) => {
            if (a && b) {
              return a.concat(b);
            } else if (!a) {
              return b;
            }
            return a;
          }, []);
          return new Promise(resolve => {
            result.push({status:200, id:commands.id});
            resolve(result);
          });
        });
        
      default:
        throw new Error('unknown action:' + commands.act);
      }

      return new Promise(resolve => resolve({status:400, errCommands: commands}));
    }
    return this._performCommand(commands);
  }
  
  _buildErrResult(err, c) {
    if (err instanceof Error) {
      return {status:500, message:err.toString(), stack:err.stack, id:c.id};
    } else {
      err.id = c.id;
      return err;
    }
  }
  
  _performCommand(c, result) {
    return new Promise((resolve, reject) => {
      try {
        if (!result) {
          result = [];
        } else if (!Array.isArray(result)) {
          result = [result];
        }
        switch(c.cat) {
        case 'sys':
          return this._performSysCommand(c).then(sysResult => {
            if (sysResult) {
              sysResult.id = c.id;
              result.push(sysResult);
            } else {
              result.push({status:200, id:c.id});
            }
            return resolve(result);
          }).catch(err => {
            result.push(this._buildErrResult(err, c));
            return reject(result);
          });
        default:
          result.push(this._buildErrResult({status:400}, c));
          return reject(result);
        }
      } catch (err) {
        result.push(this._buildErrResult(err, c));
        return reject(result);
      }
    });
  }

  _performSysCommand(c) {
    switch(c.act) {
    case 'provision':
      return this._performProvision(c);
    case 'syncflows':
      return this._performSyncFlows(c);
    case 'updateflows':
      return this._performUpdateFlows(c);
    case 'inspect':
      return this._performInspect(c);
    default:
      throw new Error('Unsupported action:' + c.act);
    }    
  }
  
  _performInspect(c) {
    return new Promise((resolve, reject) => {
      if (!this.ciotSupported) {
        return reject({status:405});
      }
      return reject({status:501, message:'TODO!!'});
    });
  }
  
  _performProvision(c) {
    this.hearbeatIntervalMs = c.args.hearbeatIntervalMs;
    return new Promise(resolve => {
      // do stuff if any after provisioning
      return resolve();
    });
  }
  
  _performSyncFlows(c) {
    return new Promise((resolve, reject) => {
      try {
        if (c.args.flowUpdateRequired) {
          fs.readFile(this.flowFilePath, (err, data) => {
            if (err) {
              return reject(err);
            }
            this._setFlowSignature(data);
            try {
              data = JSON.parse(data);
            } catch (_) {
              return reject({status:500, message:'My flow is invalid'});
            }
            return resolve({status:202, commands: {
              cat: 'sys',
              act: 'updateflows',
              args: {
                name: path.basename(this.flowFilePath),
                signature: this.flowFileSignature,
                content: data
              }
            }});
          });
          return;
        }
        if (this.flowFileSignature !== c.args.expectedSignature) {
          return resolve({status:202, commands: {
            cat: 'sys',
            act: 'deliverflows'
          }});
        }
        // 304 Not Modified
        return resolve({status:304});
      } catch (err) {
        return reject(err);
      }
    });
  }
  
  _performUpdateFlows(c) {
    return new Promise((resolve, reject) => {
      try {
        if (!c.args.content) {
          return reject({status:400});
        }
        fs.writeFile(this.flowFilePath, c.args.content, err => {
          if (err) {
            return reject(err);
          }
          this._setFlowSignature(c.args.content);
          return resolve({status:200, reboot:true});
        });
      } catch (err) {
        return reject(err);
      }
    });
  }

  testIfCANDYIoTInstalled() {
    return new Promise((resolve, reject) => {
      let which = cproc.spawn('which', ['ciot'], { timeout: 1000 });
      which.on('close', code => {
        let ciotSupported = (code === 0);
        resolve(ciotSupported);
      });
      which.on('error', err => {
        reject(err);
      });
    }).then(ciotSupported => {
      this.ciotSupported = ciotSupported;
      return new Promise((resolve, reject) => {
        let version = process.env.DEBUG_CIOTV || '';
        if (ciotSupported) {
          let ciot = cproc.spawn('ciot', ['info','version'], { timeout: 1000 });
          ciot.stdout.on('data', data => {
            try {
              let ret = JSON.parse(data);
              version = ret.version;
            } catch (e) {
              this.RED.log.info(e);
            }
          });
          ciot.on('close', () => {
            resolve(version);
          });
          ciot.on('error', err => {
            reject(err);
          });
        }
        resolve(version);
      });
    });
  }
  
  _setFlowSignature(data) {
    let sha1 = crypto.createHash('sha1');
    sha1.update(data);
    this.flowFileSignature = sha1.digest('hex');
  }
  
  testIfUIisEnabled(flowFilePath) {
    if (flowFilePath) {
      this.flowFilePath = flowFilePath;
    } else {
      flowFilePath = this.flowFilePath;
    }
    return new Promise(resolve => {
      fs.readFile(flowFilePath, (err, data) => {
        if (err) {
          return resolve(true);
        }
        this._setFlowSignature(data);
        this.RED.log.info(`[CANDY RED] flowFileSignature: ${this.flowFileSignature}`);

        let flows = JSON.parse(data);
        if (!Array.isArray(flows)) {
          return resolve(true);
        }
        resolve(flows.filter(f => {
          return f.type === 'CANDY EGG account';
        }).reduce((p, c) => {
          return p && !c.headless;
        }, true));
      });
    });
  }
}
