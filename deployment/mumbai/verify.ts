/* eslint-disable no-undef */
// @ts-nocheck
const execSync = require("child_process").execSync;
const {
    getDeployedContracts,
    getVerifiedContract,
    updateVerifiedContract,
} = require("../deployUtils");

const fs = require("fs");

const VERIFY_ARGS_PATH = "./deployment/mumbai/verify_args/";

let deployedContracts, network;

const poolConfigAddress = "0xeDF383EB56a6551Bbd12920721715db4Cd9041E2";

const getArgsFile = async function (contractName) {
    const argsFile = `${VERIFY_ARGS_PATH}${contractName}.js`;
    return argsFile;
};

const writeVerifyArgs = async function (contractName, args) {
    const argsFile = await getArgsFile(contractName);
    let data = `module.exports = [
        ${args.toString()},
        ];`;
    await fs.mkdir(`${VERIFY_ARGS_PATH}`, { recursive: true }, (err) => {
        if (err) throw err;
    });
    fs.writeFileSync(argsFile, data, { flag: "w" });
    return argsFile;
};

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function etherscanVerify(contractName, contractAddress, argsFile, logMessage) {
    await sleep(5000);
    logMessage = !logMessage ? contractAddress : logMessage;
    console.log(`Verifying ${contractName}:${logMessage}`);

    const command = !argsFile
        ? `yarn hardhat verify '${contractAddress}' --network ${network}`
        : `yarn hardhat verify ${contractAddress} --constructor-args ${argsFile} --network ${network}`;
    let result;
    try {
        const verifyResult = execSync(command);
        console.log(verifyResult);
        result = "successful";
    } catch (error) {
        if (!error.toString().toLowerCase().includes("already verified")) {
            throw error;
        } else {
            result = "already verified";
        }
    }
    console.log(`Verifying ${contractName}:${logMessage} ended!`);
    return result;
}

async function verifyContract(contractKey, args) {
    const verified = await getVerifiedContract(contractKey);
    if (verified) {
        console.log(`${contractKey} is already verified!`);
        return "already verified";
    }

    if (!deployedContracts[contractKey]) {
        throw new Error(`${contractKey} not deployed yet!`);
    }
    let result;
    if (args) {
        const argsFile = await writeVerifyArgs(contractKey, args);
        result = await etherscanVerify(contractKey, deployedContracts[contractKey], argsFile);
    } else {
        result = await etherscanVerify(contractKey, deployedContracts[contractKey]);
    }
    await updateVerifiedContract(contractKey);
    return result;
}

async function verifyContracts() {
    network = (await hre.ethers.provider.getNetwork()).name;
    console.log("network : ", network);
    deployedContracts = await getDeployedContracts();
    const accounts = await hre.ethers.getSigners();
    if (accounts.length == 0) {
        throw new Error("Accounts not set!");
    }

    const verifyEvaluationAgentNFT = await verifyContract("EvaluationAgentNFT");
    console.log(`Verify EvaluationAgentNFT result: ${verifyEvaluationAgentNFT}`);

    const verifyHumaConfig = await verifyContract("HumaConfig");
    console.log(`Verify HumaConfig result: ${verifyHumaConfig}`);

    const verifyMockToken = await verifyContract("MockToken");
    console.log(`Verify MockToken result: ${verifyMockToken}`);

    const verifyPoolConfig = await verifyContract("PoolConfig");
    console.log(`Verify PoolConfig result: ${verifyPoolConfig}`);

    const verifyPoolFeeManager = await verifyContract("PoolFeeManager");
    console.log(`Verify PoolFeeManager result: ${verifyPoolFeeManager}`);

    const verifyPoolSafe = await verifyContract("PoolSafe");
    console.log(`Verify PoolSafe result: ${verifyPoolSafe}`);

    const verifyBorrowerFirstLossCover = await verifyContract("BorrowerFirstLossCover");
    console.log(`Verify BorrowerFirstLossCover result: ${verifyBorrowerFirstLossCover}`);

    const verifyAffiliateFirstLossCover = await verifyContract("AffiliateFirstLossCover");
    console.log(`Verify AffiliateFirstLossCover result: ${verifyAffiliateFirstLossCover}`);

    const verifyFixedSeniorYieldTranchePolicy = await verifyContract(
        "FixedSeniorYieldTranchePolicy",
    );
    console.log(
        `Verify FixedSeniorYieldTranchePolicy result: ${verifyFixedSeniorYieldTranchePolicy}`,
    );

    const verifyPool = await verifyContract("Pool");
    console.log(`Verify Pool result: ${verifyPool}`);

    const verifyEpochManager = await verifyContract("EpochManager");
    console.log(`Verify EpochManager result: ${verifyEpochManager}`);

    const verifySeniorTrancheVault = await verifyContract("SeniorTrancheVault");
    console.log(`Verify SeniorTrancheVault result: ${verifySeniorTrancheVault}`);

    const verifyJuniorTrancheVault = await verifyContract("JuniorTrancheVault");
    console.log(`Verify JuniorTrancheVault result: ${verifyJuniorTrancheVault}`);

    const verifyCalendar = await verifyContract("Calendar");
    console.log(`Verify Calendar result: ${verifyCalendar}`);

    const verifyCreditLine = await verifyContract("CreditLine");
    console.log(`Verify CreditLine result: ${verifyCreditLine}`);

    const verifyCreditDueManager = await verifyContract("CreditDueManager");
    console.log(`Verify CreditDueManager result: ${verifyCreditDueManager}`);

    const verifyReceivable = await verifyContract("Receivable");
    console.log(`Verify Receivable result: ${verifyReceivable}`);
}

verifyContracts()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
