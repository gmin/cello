/*
 SPDX-License-Identifier: Apache-2.0
*/
'use strict';

const Service = require('egg').Service;
const ObjectID = require('mongodb').ObjectID;
const fs = require('fs-extra');
const commonFs = require('fs');
const shell = require('shelljs');
const path = require('path');
const awaitWriteStream = require('await-stream-ready').write;
const sendToWormhole = require('stream-wormhole');
const AdmZip = require('adm-zip');
const rimraf = require('rimraf');

class SmartContractService extends Service {
  async list() {
    const { ctx } = this;
    return await ctx.model.SmartContract.find({ user: ctx.user.id });
  }
  async copySystemSmartContract(userId) {
    const { ctx, config } = this;
    const smartContractRootDir = `${config.dataDir}/${userId}/smart_contract`;
    for (const networkType in config.default.smartContracts) {
      const networkSmartContract = config.default.smartContracts[networkType];
      for (const idx in networkSmartContract) {
        const smartContractId = new ObjectID();
        const smartContract = networkSmartContract[idx];
        const smartContractPath = `${smartContractRootDir}/${smartContractId}`;
        const smartContractCodePath = `${smartContractRootDir}/${smartContractId}/${smartContract.version}`;
        fs.ensureDirSync(smartContractCodePath);
        shell.cp('-R', `${smartContract.path}/*`, smartContractCodePath);
        await ctx.model.SmartContract.create({
          _id: smartContractId,
          name: smartContract.name,
          description: smartContract.description,
          path: smartContractPath,
          user: userId,
        });
        await ctx.model.SmartContractCode.create({
          smartContract: smartContractId,
          path: smartContractCodePath,
          version: smartContract.version,
        });
      }
    }
  }
  async storeSmartContract(stream) {
    const { ctx, config } = this;
    const smartContractRootDir = `${config.dataDir}/${ctx.user.id}/smart_contract`;
    const smartContractId = new ObjectID();
    const targetFileName = `${smartContractId}${path.extname(stream.filename)}`;
    const smartContractPath = `${smartContractRootDir}/${smartContractId}`;
    const smartContractCodePath = `${smartContractRootDir}/${smartContractId}/tmp`;
    const zipFile = path.join(smartContractPath, targetFileName);
    fs.ensureDirSync(smartContractCodePath);
    const writeStream = fs.createWriteStream(zipFile);
    try {
      await awaitWriteStream(stream.pipe(writeStream));
    } catch (err) {
      await sendToWormhole(stream);
      return {
        success: false,
      };
    }
    const zip = AdmZip(zipFile);
    zip.extractAllTo(smartContractCodePath, true);
    commonFs.unlinkSync(zipFile);
    await ctx.model.SmartContract.create({
      _id: smartContractId,
      path: smartContractPath,
      user: ctx.user.id,
    });
    const smartContractCode = await ctx.model.SmartContractCode.create({
      smartContract: smartContractId,
      path: smartContractCodePath,
    });
    return {
      id: smartContractCode._id.toString(),
      success: true,
    };
  }
  async removeSmartContractCode(id) {
    const { ctx } = this;
    const smartContractCode = await ctx.model.SmartContractCode.findOne({ _id: id }).populate('smartContract');
    if (smartContractCode) {
      await smartContractCode.remove();
      if (smartContractCode.smartContract) {
        const codeCount = await ctx.model.SmartContractCode.count({ smartContract: smartContractCode.smartContract });
        if (codeCount === 0) {
          await smartContractCode.smartContract.remove();
        }
      }
    }
  }
  async updateSmartContractCode(id) {
    const { ctx } = this;
    const smartContractCode = await ctx.model.SmartContractCode.findOne({ _id: id }).populate('smartContract');
    if (!smartContractCode || !smartContractCode.smartContract) {
      return {
        success: false,
      };
    }
    const smartContract = smartContractCode.smartContract;
    const version = ctx.request.body.version || smartContractCode.version;
    const description = ctx.request.body.description || smartContract.description;
    const smartContractPath = smartContractCode.smartContract.path;
    const name = ctx.request.body.name || smartContract.name;
    const smartContractCodePath = `${smartContractPath}/${version}`;
    if (smartContractCodePath !== smartContractCode.path) {
      fs.ensureDirSync(smartContractCodePath);
      await shell.cp('-R', `${smartContractCode.path}/*`, smartContractCodePath);
      rimraf(smartContractCode.path, function() {
        ctx.logger.debug(`delete smart contract path ${smartContractCode.path}`);
      });
    }
    smartContractCode.path = smartContractCodePath;
    smartContractCode.version = version;
    await smartContractCode.save();
    smartContract.name = name;
    smartContract.description = description;
    await smartContract.save();
    return {
      success: true,
    };
  }
  async deleteSmartContract(id) {
    const { ctx } = this;
    const smartContract = await ctx.model.SmartContract.findOne({ _id: id });
    const codes = await ctx.model.SmartContractCode.find({ smartContract });
    for (const idx in codes) {
      await codes[idx].remove();
    }
    await smartContract.remove();
  }
}

module.exports = SmartContractService;
