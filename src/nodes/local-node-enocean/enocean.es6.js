'use strict';
/*
 * EnOcean Serial Node for Packet Type 10: RADIO_ERP2
 * Supported Protocols (Partially):
 * - EnOcean Serial Protocol 3 (ESP3) V1.27 / July 30, 2014
 * - EnOcean Radio Protocol 2 SPECIFICATION V1.0 September 26, 2013
 *
 * This node expects 'node-red-node-serialport' to be available
 * on the editor in order to use its `/serialports` endpoint.
 */

import { SerialPool } from './lib/enocean';
import { ERP2_HANDLERS } from './lib/eep_handlers';

export default function(RED) {
  function EnOceanPortNode(n) {
    RED.nodes.createNode(this, n);
    let that = this;
    try {
      that.serialPort = n.serialPort;
      EnOceanPortNode.pool.add(that);
    } catch (e) {
      RED.log.warn(RED._('enocean.errors.serialPortError', { error: e }));
    }
  }
  EnOceanPortNode.pool = new SerialPool(RED);
  RED.nodes.registerType('EnOcean Port', EnOceanPortNode);

  function EnOceanInNode(n) {
    RED.nodes.createNode(this, n);
    let that = this;
    that.name = n.name;
    that.originatorId = n.originatorId;
    that.eepType = n.eepType;
    that.addEepType = n.addEepType;
    that.useString = n.useString;
    that.enoceanPortNodeId = n.enoceanPort;
    that.enoceanPortNode = RED.nodes.getNode(that.enoceanPortNodeId);
    that.on('close', done => {
      if (that.enoceanPortNode) {
        EnOceanPortNode.pool.close(that.enoceanPortNode.serialPort).then(() => {
          done();
        });
      } else {
        done();
      }
    });
    try {
      let enocean = EnOceanPortNode.pool.get(that.enoceanPortNode.serialPort);
      enocean.port.on(`ctx-${that.originatorId}`, ctx => {
        let handleIt = ERP2_HANDLERS[that.eepType];
        if (!handleIt) {
          RED.log.warn(RED._('enocean.warn.noHandler', { eepType: that.eepType }));
          return;
        }
        let payload = handleIt(ctx);
        payload.tstamp = Date.now();
        payload.rssi = ctx.container.dBm;
        payload.id = ctx.originatorId;
        if (that.addEepType) {
          payload.eep = that.eepType;
        }
        if (that.useString) {
          payload = JSON.stringify(payload);
        }
        that.send({ payload: payload });
      });
      enocean.port.on('ready', () => {
        that.status({ fill: 'green', shape: 'dot', text: 'node-red:common.status.connected'});
      });
      enocean.port.on('closed', () => {
        that.status({ fill: 'red', shape: 'ring', text: 'node-red:common.status.not-connected'});
      });
    } catch (e) {
      RED.log.warn(RED._('enocean.errors.serialPortError', { error: e }));
    }
  }
  RED.nodes.registerType('EnOcean in', EnOceanInNode);

  RED.httpAdmin.get('/eeps', RED.auth.needsPermission('eep.read'), function(req,res) {
    res.json(Object.keys(ERP2_HANDLERS));
  });

}
