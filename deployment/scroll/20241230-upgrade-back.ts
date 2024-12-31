/* eslint-disable no-undef */
import hre, { network } from "hardhat";
import { getDeployedContracts, sendTransaction } from "../deployUtils";
let deployer;
let networkName;
let deployedContracts;
let protocolOwner;

async function main() {
    // const networkName = (await hre.ethers.provider.getNetworkName()).name;
    networkName = network.name;
    console.log("networkName : ", networkName);
    const accounts = await hre.ethers.getSigners();
    if (accounts.length == 0) {
        throw new Error("Accounts not set!");
    }
    [deployer] = await accounts;

    console.log("deployer address: " + deployer.address);

    deployedContracts = await getDeployedContracts(networkName);
    console.log(deployedContracts);

    await upgradeProxies();
}

async function impersonateAccount(account: string) {
    console.log("impersonating account: " + account);
    await hre.network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [account],
    });

    await hre.network.provider.send("hardhat_setBalance", [
        account,
        hre.ethers.BigNumber.from("1000000000000000000000").toHexString(),
    ]);
    return await hre.ethers.getSigner(account);
}

async function getPoolConfig(poolId: number) {
    const poolFactory = await hre.ethers.getContractAt(
        "PoolFactory",
        deployedContracts["PoolFactory"],
    );

    console.log(await poolFactory.checkPool(1));
    const poolConfigAddress = (await poolFactory.checkPool(1))[4];
    console.log(`Pool config address ${poolConfigAddress}`);
    const poolConfig = await hre.ethers.getContractAt("PoolConfig", poolConfigAddress);
    return poolConfig;
}

async function upgradeProxies() {
    const poolConfig = await getPoolConfig(1);
    const humaConfig = await hre.ethers.getContractAt("HumaConfig", await poolConfig.humaConfig());
    console.log(await humaConfig.owner());
    const contracts = [
        ["tranchesPolicy", "0x941687792107eaC859B820d1636936382F3189aa"],
        ["pool", "0x34eA029c5195F8fb4fe59b492be1738a9Dd959AC"],
        ["epochManager", "0x5Cf4467F129e87274196a95a47BdE57f2C3F6C56"],
        ["juniorTranche", "0x23E32ea325D4614634986264bF5A419304665116"],
        ["seniorTranche", "0x23E32ea325D4614634986264bF5A419304665116"],
        ["credit", "0x3Fee297FaD2e7c646a971c6A0408c27D62853d18"],
        ["creditManager", "0x8F71112Ebd21969baDe371036AbC13960f216BC8"],
    ];
    for (const [contract, implAddress] of contracts) {
        const contractAddress = await poolConfig.callStatic[contract]();
        console.log(`${contract} address: ${contractAddress}`);
        const Contract = await hre.ethers.getContractAt("PoolConfigCache", contractAddress);
        await sendTransaction("PoolConfigCache", Contract, "upgradeTo", [implAddress]);
    }
}
main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
