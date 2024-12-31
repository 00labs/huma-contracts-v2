/* eslint-disable no-undef */
import { Signer } from "ethers";
import hre, { network } from "hardhat";
import { getDeployedContracts, sendTransaction } from "../deployUtils";
let deployer;
let networkName;
let deployedContracts;
let borrower;
const RECEIVABLE_ID = 44;
const USDC_ADDRESS = "0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4";
const USDC_MAP_SLOT = "0x9";

async function main() {
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

    // let ethAmount = ethers.BigNumber.from("1000000000000000000000");

    // await hre.network.provider.send("hardhat_setBalance", [
    //     deployer.address,
    //     ethAmount.toHexString(),
    // ]);
    const borrowerAddress = "0x08534d9b632a7A35d7af4aAe5d487A15FC247691";
    // borrower = await impersonateAccount(borrowerAddress);

    borrower = await hre.ethers.getImpersonatedSigner(borrowerAddress);
    await borrower.sendTransaction({
        to: deployer.address,
        value: hre.ethers.utils.parseEther("0.01"),
    });

    // const IERC20 = "@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20";
    // const usdc = await hre.ethers.getContractAt(IERC20, USDC_ADDRESS);
    // const usdcWithSigner = await usdc.connect(await hre.ethers.getSigner(borrowerAddress));
    // await usdcWithSigner.approve(deployer.address, hre.ethers.constants.MaxUint256);

    // await getUSDC();
    // await createReceivable();
    // await getReceivableId();
    // await replaceEA();
    // await approveReceivable();
    // await replacePoolOwnerTreasury();
    // await transferReceivable();

    // await getUSDC(deployer.address);
    // await approveUSDC(deployer);
    // await approveUSDCforBorrower(borrower.address);
    // await makePayment();
    // await checkCreditRecord();

    // await processYield();
    // await setBlockTimeStamp();
    // await closeEpoch();

    // await deployContracts();
    // await initPoolFactory();
    // await createPool();
    // await setPool();
    // await addOwnership();
    // await migrateStorage();
}

async function impersonateAccount(account: string) {
    console.log("impersonating account: " + account);
    await network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [account],
    });

    await network.provider.send("hardhat_setBalance", [
        account,
        hre.ethers.BigNumber.from("1000000000000000000000").toHexString(),
    ]);
    return await hre.ethers.getSigner(account);
}

async function setToken(tokenAddress, mapSlot, address, amount) {
    const mintAmount = hre.ethers.utils.hexZeroPad(amount.toHexString(), 32);
    const slot = hre.ethers.utils.hexStripZeros(
        hre.ethers.utils.keccak256(
            hre.ethers.utils.defaultAbiCoder.encode(["address", "uint256"], [address, mapSlot]),
        ),
    );
    await hre.network.provider.send("hardhat_setStorageAt", [tokenAddress, slot, mintAmount]);
}

async function mintToken(token, mapSlot, address, amount) {
    const beforeAmount = await token.balanceOf(address);
    const newAmount = amount.add(beforeAmount);
    await setToken(token.address, mapSlot, address, newAmount);
}

async function getUSDC(account: string) {
    const IERC20 = "@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20";
    const usdc = await hre.ethers.getContractAt(IERC20, USDC_ADDRESS);

    console.log(await usdc.balanceOf(account));
    await mintToken(usdc, USDC_MAP_SLOT, account, hre.ethers.BigNumber.from("1000000000000"));

    console.log(await usdc.balanceOf(account));
}

async function approveUSDC(account: Signer) {
    const IERC20 = "@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20";
    const usdc = await hre.ethers.getContractAt(IERC20, USDC_ADDRESS);
    const usdcWithSigner = await usdc.connect(account);
    const poolConfig = await getPoolConfig(1);
    const poolSafeAddress = await poolConfig.poolSafe();
    await usdcWithSigner.approve(poolSafeAddress, hre.ethers.constants.MaxUint256);
}

async function approveUSDCforBorrower(account: string) {
    const IERC20 = "@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20";
    const usdc = await hre.ethers.getContractAt(IERC20, USDC_ADDRESS);
    const usdcWithSigner = await usdc.connect(await hre.ethers.getSigner(account));
    const poolConfig = await getPoolConfig(1);
    const poolSafeAddress = await poolConfig.poolSafe();
    console.log(usdcWithSigner);
    await usdcWithSigner.approve(poolSafeAddress, hre.ethers.constants.MaxUint256);
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

async function createReceivable() {
    const poolConfig = await getPoolConfig(1);
    const Contract = await hre.ethers.getContractAt(
        "Receivable",
        "0x89B599dCc82c42Ef2f17ae39c44e4F6764003518",
    );
    await sendTransaction("Receivable", Contract, "grantRole", [
        "0x9f2df0fed2c77648de5860a4cc508cd0818c85b8b8a1ab4ceeef8d981c8956a6",
        deployer.address,
    ]);
    const receipt = await sendTransaction("Receivable", Contract, "createReceivable", [
        840,
        1000000000000,
        1750463999999,
        "",
        "",
    ]);
    console.log(receipt);
}

async function transferReceivable() {
    const poolConfig = await getPoolConfig(1);
    const creditManagerAddress = await poolConfig.callStatic["credit"]();
    const Contract = await hre.ethers.getContractAt(
        "Receivable",
        "0x89B599dCc82c42Ef2f17ae39c44e4F6764003518",
    );
    await sendTransaction("Receivable", Contract, "transferFrom", [
        deployer.address,
        creditManagerAddress,
        RECEIVABLE_ID,
    ]);
}

async function replaceEA() {
    const poolConfig = await getPoolConfig(1);
    const Contract = await hre.ethers.getContractAt("PoolConfig", poolConfig.address);
    await sendTransaction("PoolConfig", Contract, "setEvaluationAgent", [deployer.address]);
}

async function approveReceivable() {
    const poolConfig = await getPoolConfig(1);
    const Contract = await hre.ethers.getContractAt(
        "ReceivableBackedCreditLineManager",
        poolConfig.callStatic["creditManager"](),
    );
    await sendTransaction("ReceivableBackedCreditLineManager", Contract, "approveReceivable", [
        borrower.address,
        RECEIVABLE_ID,
    ]);
}

async function getReceivableId() {
    const poolConfig = await getPoolConfig(1);
    const Contract = await hre.ethers.getContractAt(
        "Receivable",
        "0x89B599dCc82c42Ef2f17ae39c44e4F6764003518",
    );
    console.log(await Contract.getReceivable(RECEIVABLE_ID));
}

async function replacePoolOwnerTreasury() {
    const poolConfig = await getPoolConfig(1);
    const Contract = await hre.ethers.getContractAt("PoolConfig", poolConfig.address);
    await sendTransaction("PoolConfig", Contract, "setPoolOwnerTreasury", [deployer.address]);
}

async function makePayment() {
    const poolConfig = await getPoolConfig(1);
    const contractAddress = await poolConfig.callStatic["credit"]();
    console.log(`Credit address: ${contractAddress}`);
    const Contract = await hre.ethers.getContractAt("ReceivableBackedCreditLine", contractAddress);
    const ContractWithSigner = Contract.connect(borrower);
    await sendTransaction(
        "ReceivableBackedCreditLine",
        Contract,
        "makePaymentOnBehalfOfWithReceivable",
        [borrower.address, RECEIVABLE_ID, 788_283_000_000],
    );
    // await sendTransaction(
    //     "ReceivableBackedCreditLine",
    //     ContractWithSigner,
    //     "makePaymentWithReceivable",
    //     [borrower.address, RECEIVABLE_ID, 780_000_000_000],
    // );
}

async function checkCreditRecord() {
    const poolConfig = await getPoolConfig(1);
    const contractAddress = await poolConfig.callStatic["credit"]();
    const Contract = await hre.ethers.getContractAt("ReceivableBackedCreditLine", contractAddress);
    const creditHash = await Contract.getCreditHash(borrower.address);
    console.log(await Contract.getCreditRecord(creditHash));
    console.log(await Contract.getDueDetail(creditHash));

    const FixedSeniorYieldTranchesPolicyAddress = await poolConfig.callStatic["tranchesPolicy"]();
    const FixedSeniorYieldTranchesPolicy = await hre.ethers.getContractAt(
        "FixedSeniorYieldTranchesPolicy",
        FixedSeniorYieldTranchesPolicyAddress,
    );
    console.log(await FixedSeniorYieldTranchesPolicy.seniorYieldTracker());
}

async function setBlockTimeStamp() {
    await hre.network.provider.send("evm_setNextBlockTimestamp", [1735689900]);
}

async function closeEpoch() {
    const poolConfig = await getPoolConfig(1);
    const contractAddress = await poolConfig.callStatic["epochManager"]();
    const Contract = await hre.ethers.getContractAt("EpochManager", contractAddress);
    await sendTransaction("EpochManager", Contract, "closeEpoch", []);
}

async function processYield() {
    const poolConfig = await getPoolConfig(1);
    let contractAddress;
    let Contract;
    const abi = ["function processYieldForLenders() external"];
    for (const tranche of ["juniorTranche", "seniorTranche"]) {
        contractAddress = await poolConfig.callStatic[tranche]();
        Contract = await hre.ethers.getContractAt(abi, contractAddress);
        await Contract["processYieldForLenders()"]();
    }
    // await sendTransaction("TrancheVault", Contract, "processYieldForLenders", []);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
