/* eslint-disable no-useless-escape */
// @ts-nocheck
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable no-undef */
import { BigNumber as BN, ethers } from "ethers";
import fs from "fs";
const DEPLOYED_PATH = "./deployment/scroll-temp/";

const MAX_FEE_PER_GAS = 300_000_000;
const MAX_PRIORITY_FEE_PER_GAS = 100_000_000;

const getContractAddressFile = async function (fileType = "deployed", network) {
    if (!network) {
        throw new Error("Network not provided!");
    }
    const contractAddressFile = `${DEPLOYED_PATH}${network}-${fileType}-contracts.json`;
    // console.log("contractAddressFile: ", contractAddressFile);
    return contractAddressFile;
};

const readFileContent = async function (fileType = "deployed", network) {
    const contractAddressFile = await getContractAddressFile(fileType, network);
    console.log("contractAddressFile: ", contractAddressFile);
    const data = fs.readFileSync(contractAddressFile, { flag: "a+" });
    const content = data.toString();
    if (content.length == 0) {
        return "{}";
    }
    return content;
};

const getDeployedContract = async function (contractName, network) {
    return await getContract("deployed", contractName, network);
};

export const getInitilizedContract = async function (contractName, network) {
    return await getContract("initialized", contractName, network);
};

const getUpgradedContract = async function (contractName, network) {
    return await getContract("upgraded", contractName, network);
};

export const getVerifiedContract = async function (contractName, network) {
    return await getContract("verified", contractName, network);
};

export const getDeployedContracts = async function (network) {
    return await getContracts("deployed", network);
};

async function getContracts(type, network) {
    const content = await readFileContent(type, network);
    const contracts = JSON.parse(content);
    return contracts;
}

async function getContract(type, contractName, network) {
    const contracts = await getContracts(type, network);
    return contracts[contractName];
}

export const updateDeployedContract = async function (contractName, contractAddress, network) {
    await updateContract("deployed", contractName, contractAddress, network);
};

export const updateInitializedContract = async function (contractName, network) {
    await updateContract("initialized", contractName, "Done", network);
};

const updateUpgradedContract = async function (contractName, network) {
    await updateContract("upgraded", contractName, "Done", network);
};

export const updateVerifiedContract = async function (contractName, network) {
    await updateContract("verified", contractName, "Done", network);
};

async function updateContract(type, contractName, value, network) {
    const oldData = await readFileContent(type, network);
    let contracts = JSON.parse(oldData);
    contracts[contractName] = value;
    const newData = JSON.stringify(contracts).replace(/\,/g, ",\n");
    const deployedContractsFile = await getContractAddressFile(type, network);
    fs.writeFileSync(deployedContractsFile, newData);
}

const getSigner = async function (index) {
    const accounts = await hre.ethers.getSigners();
    return accounts[index];
};

const checkReceiptOk = async function (transationPromise) {
    const receipt = await transationPromise.wait();

    if (receipt.status == 0) {
        throw new Error("Receipt Revert!");
    }
};

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

export const sendTransaction = async function (
    contractName,
    contractInstance,
    methodName,
    parameters? = [any],
    logMessage?,
) {
    // const gasPrice = await hre.ethers.provider.getGasPrice()
    await sleep(5000);
    logMessage = !logMessage ? methodName : logMessage;
    const method = contractInstance[methodName];
    console.log(`${contractName}:${logMessage} Start!`);
    console.log(`paramaters: ${parameters}`);
    // await checkReceiptOk(
    //     await method(...parameters, {
    //         maxFeePerGas: MAX_FEE_PER_GAS,
    //         maxPriorityFeePerGas: MAX_PRIORITY_FEE_PER_GAS,
    //     }),
    // );
    await checkReceiptOk(await method(...parameters));
    console.log(`${contractName}:${logMessage} End!`);
};

export async function deploy(
    network,
    contractName,
    keyName,
    contractParameters?,
    libraries?,
    deployer?,
) {
    const deployed = await getDeployedContract(keyName, network);
    if (deployed) {
        console.log(`${keyName} already deployed: ${deployed}`);
        let Contract;
        if (libraries) {
            Contract = await hre.ethers.getContractFactory(contractName, libraries);
        } else {
            Contract = await hre.ethers.getContractFactory(contractName);
        }
        return Contract.attach(deployed);
    }
    let Contract;
    if (libraries) {
        Contract = await hre.ethers.getContractFactory(contractName, libraries);
    } else {
        Contract = await hre.ethers.getContractFactory(contractName);
    }
    if (deployer) {
        Contract = Contract.connect(deployer);
    }
    // const gasPrice = await hre.ethers.provider.getGasPrice()
    // const gasPrice = web3.utils.toHex('33000000000')

    let contract;
    if (contractParameters) {
        contract = await Contract.deploy(...contractParameters, {
            maxFeePerGas: MAX_FEE_PER_GAS,
            maxPriorityFeePerGas: MAX_PRIORITY_FEE_PER_GAS,
        });
    } else {
        contract = await Contract.deploy({
            maxFeePerGas: MAX_FEE_PER_GAS,
            maxPriorityFeePerGas: MAX_PRIORITY_FEE_PER_GAS,
        });
    }
    // if (contractParameters) {
    //     contract = await Contract.deploy(...contractParameters);
    // } else {
    //     contract = await Contract.deploy();
    // }
    console.log(`${keyName} TransactionHash: ${contract.deployTransaction.hash}`);
    await contract.deployed();
    console.log(`${keyName}: ${contract.address}`);
    await updateDeployedContract(keyName, contract.address, network);
    console.log(`Deploy ${keyName} Done!`);
    return contract;
}

const toFixedDecimal = function (number, decimals) {
    return BN.from(number).mul(BN.from(10).pow(BN.from(decimals)));
};

const impersonate = async function (account) {
    await hre.network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [account],
    });
    const amount = BN.from(10).mul(ethers.constants.WeiPerEther);
    await network.provider.send("hardhat_setBalance", [account, amount.toHexString()]);
    return await hre.ethers.provider.getSigner(account);
};

async function advanceClock(days) {
    await network.provider.send("evm_increaseTime", [3600 * 24 * days]);
    await network.provider.send("evm_mine", []);
}
