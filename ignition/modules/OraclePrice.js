
// This setup uses Hardhat Ignition to manage smart contract deployments.
// Learn more about it at https://hardhat.org/ignition

const { buildModule } = require("@nomicfoundation/hardhat-ignition/modules");
const { ehters, ethers } = require('hardhat');
require('dotenv').config();

module.exports = buildModule("MockPriceOracle_modules", (m) => {
    const amount = ethers.parseEther("0.24");
    const oraclePrice = m.contract(
        "MockPriceOracle", [amount]
    );

  return { oraclePrice };
});