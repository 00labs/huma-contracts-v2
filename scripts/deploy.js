// import ethers from "ethers";
// import upgrades from "hardhat";
const ethers = require("ethers");
// const { hre, upgrades } = require("hardhat");

async function main() {
    console.log("test");
    const accounts = await hre.ethers.getSigners();
    console.log(accounts);
    const CubeToken = await hre.ethers.getContractFactory("TrancheVault");
    console.log("test");
    const cubeToken = await upgrades.deployProxy(CubeToken);
    await cubeToken.deployed();
    console.log("Token address:", cubeToken.address);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
