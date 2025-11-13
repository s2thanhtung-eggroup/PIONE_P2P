// This setup uses Hardhat Ignition to manage smart contract deployments.
// Learn more about it at https://hardhat.org/ignition

const { buildModule } = require("@nomicfoundation/hardhat-ignition/modules");
const {ethers} = require('hardhat');
require('dotenv').config();

const PIONEMINT_NFT = process.env.PIONEMINT_NFT || "";

module.exports = buildModule("PioneP2PEscrow_modules", (m) => {
  const feeTo = ethers.ZeroAddress;
  const pioneP2PEscrow = m.contract(
    "PioneP2PEscrow", 
    [
      PIONEMINT_NFT,
      feeTo
    ]
  );

  return { pioneP2PEscrow };
});