// This setup uses Hardhat Ignition to manage smart contract deployments.
// Learn more about it at https://hardhat.org/ignition

const { buildModule } = require("@nomicfoundation/hardhat-ignition/modules");
const {ethers} = require('hardhat');
require('dotenv').config();

const PIONE_TOKEN = process.env.PIONE_TOKEN || "";
const USDT_BEP20 = process.env.USDT_BEP20 || "";
const PAIR_ADDRESS = process.env.PAIR_ADDRESS || "";

module.exports = buildModule("BSCP2PEscrow_modules", (m) => {
  const feeTo = ethers.ZeroAddress;
  const bscP2PEscrow = m.contract(
    "BSCP2PEscrow", 
    [
      USDT_BEP20,
      PIONE_TOKEN,
      PAIR_ADDRESS,
      feeTo
    ]
  );

  return { bscP2PEscrow };
});