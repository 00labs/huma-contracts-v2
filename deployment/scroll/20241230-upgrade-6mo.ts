/* eslint-disable no-undef */
import { Signer } from "ethers";
import hre, { network } from "hardhat";
import { getDeployedContracts, sendTransaction } from "../deployUtils";
let deployer;
let networkName;
let deployedContracts;
let protocolOwner;

const USDC_ADDRESS = "0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4";
const USDC_MAP_SLOT = "0x9";
const RECEIVABLE_ID = 42;
const borrower = "0x08534d9b632a7A35d7af4aAe5d487A15FC247691";

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

    // let ethAmount = ethers.BigNumber.from("1000000000000000000000");

    // await hre.network.provider.send("hardhat_setBalance", [
    //     deployer.address,
    //     ethAmount.toHexString(),
    // ]);

    await upgradeReceivableBackedCreditLine();
    // await makePayment();
    // await checkCreditRecord();

    // await deployContracts();
    // await initPoolFactory();
    // await createPool();
    // await setPool();
    // await addOwnership();
    // await migrateStorage();
}

async function replacePoolOwnerTreasury() {
    const poolConfig = await getPoolConfig(1);
    const Contract = await hre.ethers.getContractAt("PoolConfig", poolConfig.address);
    await sendTransaction("PoolConfig", Contract, "setPoolOwnerTreasury", [deployer.address]);
}

async function getUSDC(account: string) {
    const IERC20 = "@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20";
    const usdc = await hre.ethers.getContractAt(IERC20, USDC_ADDRESS);

    console.log(await usdc.balanceOf(account));
    await mintToken(usdc, USDC_MAP_SLOT, account, hre.ethers.BigNumber.from("1000000000000"));

    console.log(await usdc.balanceOf(account));
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

async function approveUSDC(account: Signer) {
    const IERC20 = "@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20";
    const usdc = await hre.ethers.getContractAt(IERC20, USDC_ADDRESS);
    const usdcWithSigner = await usdc.connect(account);
    const poolConfig = await getPoolConfig(1);
    const poolSafeAddress = await poolConfig.poolSafe();
    await usdcWithSigner.approve(poolSafeAddress, hre.ethers.constants.MaxUint256);
}

async function makePayment() {
    const poolOwnerTreasury = await impersonateAccount(
        "0x73285f0013F76366e0442180C5Ae3A67Da2ab4fC",
    );
    await getUSDC(poolOwnerTreasury.address);
    await approveUSDC(poolOwnerTreasury);

    const poolConfig = await getPoolConfig(1);
    const contractAddress = await poolConfig.callStatic["credit"]();
    console.log(`Credit address: ${contractAddress}`);
    const Contract = await hre.ethers.getContractAt("ReceivableBackedCreditLine", contractAddress);
    const ContractWithSigner = Contract.connect(poolOwnerTreasury);
    await ContractWithSigner.makePaymentOnBehalfOfWithReceivable(
        borrower,
        RECEIVABLE_ID,
        95_615_000_000,
    );
    // await sendTransaction(
    //     "ReceivableBackedCreditLine",
    //     ContractWithSigner,
    //     "makePaymentOnBehalfOfWithReceivable",
    //     ["0x08534d9b632a7A35d7af4aAe5d487A15FC247691", RECEIVABLE_ID, 95_615_000_000],
    // );
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
    const creditHash = await Contract.getCreditHash(borrower);
    console.log(await Contract.getCreditRecord(creditHash));
    console.log(await Contract.getDueDetail(creditHash));

    const FixedSeniorYieldTranchesPolicyAddress = await poolConfig.callStatic["tranchesPolicy"]();
    const FixedSeniorYieldTranchesPolicy = await hre.ethers.getContractAt(
        "FixedSeniorYieldTranchesPolicy",
        FixedSeniorYieldTranchesPolicyAddress,
    );
    console.log(await FixedSeniorYieldTranchesPolicy.seniorYieldTracker());
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
    const poolConfigAddress = "0x8A89942cda613BB9Dc7a8eF6Dbdc788EE3F29410";
    console.log(`Pool config address ${poolConfigAddress}`);
    const poolConfig = await hre.ethers.getContractAt("PoolConfig", poolConfigAddress);
    return poolConfig;
}

async function upgradeReceivableBackedCreditLine() {
    const poolConfig = await getPoolConfig(1);
    const humaConfig = await hre.ethers.getContractAt("HumaConfig", await poolConfig.humaConfig());
    console.log(await humaConfig.owner());
    const contracts = [["credit", "0x3Fee297FaD2e7c646a971c6A0408c27D62853d18"]];
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
