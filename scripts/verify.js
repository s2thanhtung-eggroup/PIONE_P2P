const hre = require("hardhat");
const { ethers } = require("hardhat");
require('dotenv').config();

const PIONE_TOKEN = process.env.PIONE_TOKEN || "";
const USDT_BEP20 = process.env.USDT_BEP20 || "";
const PIONE_BRIDGE = process.env.PIONE_BRIDGE || "";
const PANCAKEROUTER = process.env.PANCAKEROUTER || "";
const PINKLOCK = process.env.PINKLOCK || "";
const PIONECHAIN_ID = process.env.PIONECHAIN_ID || "";

async function verify(address, contractName, args) {
  console.log("verifing...");
  await hre.run("verify:verify", {
    address: address,
    constructorArguments: [...args],
    contract: `contracts/${contractName}.sol:${contractName}`,
  });
  console.log(`verify ${contractName} success fully!!`);
  console.log("----------------");
}

async function main() {
  const PioneLiquidityAddress = "";
  console.log("Wait before verifying");
  await verify(
    PioneLiquidityAddress,
    "PioneLiquidityManager", 
    [
      PIONE_TOKEN,
      USDT_BEP20,
      PIONE_BRIDGE,
      PANCAKEROUTER,
      PINKLOCK,
      PIONECHAIN_ID
    ]
  );
  console.log("verify success");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
