/* eslint-disable no-undef */
import { expect } from "chai";
import fs from "fs";
import hre, { network } from "hardhat";
import { getDeployedContracts, sendTransaction } from "../deployUtils";

let deployer;
let networkName;
let deployedContracts;

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

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

    // await deployContracts();
    // await initPoolFactory();
    await createPool();
    await setPool();
    await addOwnership();
    await addTimeLock();
    await migrateStorage();
}

async function migrateStorage() {
    const poolFactory = await hre.ethers.getContractAt(
        "PoolFactory",
        deployedContracts["PoolFactory"],
    );

    console.log(await poolFactory.checkPool(1));
    const poolConfigAddress = (await poolFactory.checkPool(1))[4];
    console.log(`Pool config address ${poolConfigAddress}`);
    const poolConfig = await hre.ethers.getContractAt("PoolConfig", poolConfigAddress);

    const FixedSeniorYieldTranchesPolicyAddress = await poolConfig.tranchesPolicy();
    console.log(`FixedSeniorYieldTranchesPolicyAddress ${FixedSeniorYieldTranchesPolicyAddress}`);
    const FixedSeniorYieldTranchesPolicy = await hre.ethers.getContractAt(
        "FixedSeniorYieldTranchesPolicy",
        FixedSeniorYieldTranchesPolicyAddress,
    );

    await sendTransaction(
        "FixedSeniorYieldTranchesPolicy",
        FixedSeniorYieldTranchesPolicy,
        "copyStorageDataFromOldContract",
        [],
    );

    const OldFixedSeniorYieldTranchesPolicy = await hre.ethers.getContractAt(
        "FixedSeniorYieldTranchesPolicy",
        "0x13d8446B1b365d53B0696947fa96624b5CE19bf3",
    );
    const oldTracker = await OldFixedSeniorYieldTranchesPolicy.seniorYieldTracker();
    const newTracker = await FixedSeniorYieldTranchesPolicy.seniorYieldTracker();
    expect(oldTracker.totalAssets).to.eq(newTracker.totalAssets);
    expect(oldTracker.unpaidYield).to.eq(newTracker.unpaidYield);
    expect(oldTracker.lastUpdatedDate).to.eq(newTracker.lastUpdatedDate);

    const epochManagerAddress = await poolConfig.epochManager();
    const EpochManager = await hre.ethers.getContractAt("EpochManager", epochManagerAddress);
    await sendTransaction("EpochManager", EpochManager, "copyStorageDataFromOldContract", []);
    const currentEpoch = await EpochManager.currentEpoch();

    const oldEpochManager = await hre.ethers.getContractAt(
        "EpochManager",
        "0x1a2C87Be5e785493310526faA7739Bbe4E10c0F6",
    );
    const oldCurrentEpoch = await oldEpochManager.currentEpoch();
    expect(currentEpoch.id).to.eq(oldCurrentEpoch.id);
    expect(currentEpoch.endTime).to.eq(oldCurrentEpoch.endTime);

    const poolAddress = await poolConfig.pool();
    const Pool = await hre.ethers.getContractAt("Pool", poolAddress);
    await sendTransaction("Pool", Pool, "copyStorageDataFromOldContract", []);

    const oldPool = await hre.ethers.getContractAt(
        "Pool",
        "0x5227254a6aCa397e95F310b52f6D3143A5A9Ee14",
    );
    const oldTranchesAssets = await oldPool.tranchesAssets();
    const newTranchesAssets = await Pool.tranchesAssets();
    expect(oldTranchesAssets.seniorTotalAssets).to.eq(newTranchesAssets.seniorTotalAssets);
    expect(oldTranchesAssets.juniorTotalAssets).to.eq(newTranchesAssets.juniorTotalAssets);
    expect(await Pool.isPoolOn()).to.eq(true);
    expect(await Pool.isPoolClosed()).to.eq(false);

    const borrowerAddress = "0x08534d9b632a7A35d7af4aAe5d487A15FC247691";
    const creditLineAddress = await poolConfig.credit();
    const CreditLine = await hre.ethers.getContractAt(
        "ReceivableBackedCreditLine",
        creditLineAddress,
    );
    await sendTransaction(
        "ReceivableBackedCreditLine",
        CreditLine,
        "copyStorageDataFromOldContract",
        [borrowerAddress],
    );
    const oldCreditLine = await hre.ethers.getContractAt(
        "ReceivableBackedCreditLine",
        "0xc6F10af4746784a0DD095f4E5718d53ff94eB4a0",
    );
    const oldCreditHash = await oldCreditLine.getCreditHash(borrowerAddress);
    const newCreditHash = await CreditLine.getCreditHash(borrowerAddress);
    console.log(`Old credit hash ${oldCreditHash}`);
    console.log(`New credit hash ${newCreditHash}`);
    const oldCreditRecord = await oldCreditLine.getCreditRecord(oldCreditHash);
    const newCreditRecord = await CreditLine.getCreditRecord(newCreditHash);
    expect(oldCreditRecord.unbilledPrincipal).to.eq(newCreditRecord.unbilledPrincipal);
    expect(oldCreditRecord.nextDueDate).to.eq(newCreditRecord.nextDueDate);
    expect(oldCreditRecord.nextDue).to.eq(newCreditRecord.nextDue);
    expect(oldCreditRecord.yieldDue).to.eq(newCreditRecord.yieldDue);
    expect(oldCreditRecord.totalPastDue).to.eq(newCreditRecord.totalPastDue);
    expect(oldCreditRecord.missedPeriods).to.eq(newCreditRecord.missedPeriods);
    expect(oldCreditRecord.remainingPeriods).to.eq(newCreditRecord.remainingPeriods);
    expect(oldCreditRecord.state).to.eq(newCreditRecord.state);
    const oldDueDetail = await oldCreditLine.getDueDetail(oldCreditHash);
    const newDueDetail = await CreditLine.getDueDetail(newCreditHash);
    expect(oldDueDetail.lateFeeUpdatedDate).to.eq(newDueDetail.lateFeeUpdatedDate);
    expect(oldDueDetail.lateFee).to.eq(newDueDetail.lateFee);
    expect(oldDueDetail.principalPastDue).to.eq(newDueDetail.principalPastDue);
    expect(oldDueDetail.yieldPastDue).to.eq(newDueDetail.yieldPastDue);
    expect(oldDueDetail.committed).to.eq(newDueDetail.committed);
    expect(oldDueDetail.accrued).to.eq(newDueDetail.accrued);
    expect(oldDueDetail.paid).to.eq(newDueDetail.paid);

    //
    const creditLineManagerAddress = await poolConfig.creditManager();

    const CreditLineManager = await hre.ethers.getContractAt(
        "ReceivableBackedCreditLineManager",
        creditLineManagerAddress,
    );
    const receivableIds = Array.from({ length: 32 }, (_, i) => i + 1);
    console.log(`Receivable IDs ${receivableIds}`);
    await sendTransaction(
        "ReceivableBackedCreditLineManager",
        CreditLineManager,
        "copyStorageDataFromOldContract",
        [borrowerAddress, receivableIds],
    );

    const oldCreditLineManager = await hre.ethers.getContractAt(
        "ReceivableBackedCreditLineManager",
        "0x061411d05074Bc974f814AC86309D2204f4c265d",
    );
    const oldCreditConfig = await oldCreditLineManager.getCreditConfig(oldCreditHash);
    const newCreditConfig = await CreditLineManager.getCreditConfig(newCreditHash);
    expect(oldCreditConfig.creditLimit).to.eq(newCreditConfig.creditLimit);
    expect(oldCreditConfig.committedAmount).to.eq(newCreditConfig.committedAmount);
    expect(oldCreditConfig.periodDuration).to.eq(newCreditConfig.periodDuration);
    expect(oldCreditConfig.numOfPeriods).to.eq(newCreditConfig.numOfPeriods);
    expect(oldCreditConfig.yieldInBps).to.eq(newCreditConfig.yieldInBps);
    expect(oldCreditConfig.advanceRateInBps).to.eq(newCreditConfig.advanceRateInBps);
    expect(oldCreditConfig.revolving).to.eq(newCreditConfig.revolving);
    expect(oldCreditConfig.receivableAutoApproval).to.eq(newCreditConfig.receivableAutoApproval);

    const creditBorrower = await CreditLineManager.getCreditBorrower(newCreditHash);
    expect(creditBorrower).to.eq(borrowerAddress);
    const oldAvailableCredits = await oldCreditLineManager.getAvailableCredit(oldCreditHash);
    const newAvailableCredits = await CreditLineManager.getAvailableCredit(newCreditHash);
    expect(oldAvailableCredits).to.eq(newAvailableCredits);
    for (const i of receivableIds) {
        const oldReceivableBorrower = await oldCreditLineManager.receivableBorrowerMap(i);
        const newReceivableBorrower = await CreditLineManager.receivableBorrowerMap(i);
        expect(oldReceivableBorrower).to.eq(newReceivableBorrower);
    }

    // Load approved lenders from CSV file
    const approvedLendersCSV = fs.readFileSync(
        "deployment/scroll/scroll_3month_approved_lenders.csv",
        "utf-8",
    );
    const approvedLenders = approvedLendersCSV
        .split("\n")
        .slice(1) // Skip header row
        .filter((line) => line.trim()); // Remove empty lines

    console.log(`Loaded ${approvedLenders.length} approved lenders from CSV`);

    for (const [oldTranche, newTranche, epochIds] of [
        ["0x483D02C11f8F1E31C267040A6C86AaB80c428BaB", await poolConfig.juniorTranche(), [6, 7]],
        ["0x4cdCedcF50266aD9ed809048BC9874320EC902bC", await poolConfig.seniorTranche(), [7]],
    ]) {
        await copyTrancheVaultStorageData(oldTranche, newTranche, [], epochIds);

        // Process lenders in batches of 50
        for (let i = 0; i < approvedLenders.length; i += 50) {
            const lenderBatch = approvedLenders.slice(i, i + 50);
            console.log(`Processing lenders ${i} to ${i + lenderBatch.length - 1}`);
            console.log(lenderBatch);
            await copyTrancheVaultStorageData(oldTranche, newTranche, lenderBatch, []);
        }
        const trancheVaultContract = await hre.ethers.getContractAt("TrancheVault", newTranche);
        await trancheVaultContract.restoreLPTokensForTrancheVault(oldTranche);
        const oldTrancheVault = await hre.ethers.getContractAt("TrancheVault", oldTranche);
        const oldBalance = await oldTrancheVault.balanceOf(oldTranche);
        const newBalance = await trancheVaultContract.balanceOf(newTranche);
        expect(oldBalance).to.eq(newBalance);
        const oldTotalSupply = await oldTrancheVault.totalSupply();
        const newTotalSupply = await trancheVaultContract.totalSupply();
        expect(oldTotalSupply).to.eq(newTotalSupply);
        console.log("Done!");
    }
}

async function copyTrancheVaultStorageData(
    oldTrancheVaultAddress: string,
    newTrancheVaultAddress: string,
    lenders: string[],
    epochIds: number[],
) {
    const oldTrancheVault = await hre.ethers.getContractAt("TrancheVault", oldTrancheVaultAddress);
    const newTrancheVault = await hre.ethers.getContractAt("TrancheVault", newTrancheVaultAddress);
    await sendTransaction("TrancheVault", newTrancheVault, "copyStorageDataFromOldContract", [
        oldTrancheVaultAddress,
        lenders,
        epochIds,
    ]);
    for (const epochId of epochIds) {
        const oldSummary = await oldTrancheVault.epochRedemptionSummary(epochId);
        const newSummary = await newTrancheVault.epochRedemptionSummary(epochId);
        expect(oldSummary.epochId).to.eq(newSummary.epochId);
        expect(oldSummary.totalSharesRequested).to.eq(newSummary.totalSharesRequested);
        expect(oldSummary.totalSharesProcessed).to.eq(newSummary.totalSharesProcessed);
        expect(oldSummary.totalAmountProcessed).to.eq(newSummary.totalAmountProcessed);
    }

    for (const lender of lenders) {
        const oldRedemptionRecord = await oldTrancheVault.lenderRedemptionRecords(lender);
        const newRedemptionRecord = await newTrancheVault.lenderRedemptionRecords(lender);
        expect(oldRedemptionRecord.nextEpochIdToProcess).to.eq(
            newRedemptionRecord.nextEpochIdToProcess,
        );
        expect(oldRedemptionRecord.numSharesRequested).to.eq(
            newRedemptionRecord.numSharesRequested,
        );
        expect(oldRedemptionRecord.principalRequested).to.eq(
            newRedemptionRecord.principalRequested,
        );
        expect(oldRedemptionRecord.totalAmountProcessed).to.eq(
            newRedemptionRecord.totalAmountProcessed,
        );
        expect(oldRedemptionRecord.totalAmountWithdrawn).to.eq(
            newRedemptionRecord.totalAmountWithdrawn,
        );

        const oldDepositRecord = await oldTrancheVault.depositRecords(lender);
        const newDepositRecord = await newTrancheVault.depositRecords(lender);
        expect(oldDepositRecord.principal).to.eq(newDepositRecord.principal);
        expect(oldDepositRecord.reinvestYield).to.eq(newDepositRecord.reinvestYield);
        expect(oldDepositRecord.lastDepositTime).to.eq(newDepositRecord.lastDepositTime);

        const oldBalance = await oldTrancheVault.balanceOf(lender);
        const newBalance = await newTrancheVault.balanceOf(lender);
        expect(oldBalance).to.eq(newBalance);
    }
}

async function createPool() {
    const poolFactory = await hre.ethers.getContractAt(
        "PoolFactory",
        deployedContracts["PoolFactory"],
    );
    // console.log(await poolFactory.poolImplAddress());
    await sendTransaction("PoolFactory", poolFactory, "deployPool", [
        "Arf 3 month pool",
        "0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4",
        "0x89B599dCc82c42Ef2f17ae39c44e4F6764003518",
        "fixed",
        "receivablebacked",
    ]);
}

async function setPool() {
    const poolFactory = await hre.ethers.getContractAt(
        "PoolFactory",
        deployedContracts["PoolFactory"],
    );

    console.log(await poolFactory.checkPool(1));
    const poolConfigAddress = (await poolFactory.checkPool(1))[4];
    console.log(`Pool config address ${poolConfigAddress}`);
    const poolConfig = await hre.ethers.getContractAt("PoolConfig", poolConfigAddress);

    console.log(await poolConfig.getLPConfig());

    await sendTransaction("PoolFactory", poolFactory, "setLPConfig", [1, 0, 9, 2750, 0, 90, true]);

    await sendTransaction("PoolFactory", poolFactory, "setPoolSettings", [
        1,
        5000000000000,
        10000000,
        0,
        15,
        60,
        10000,
        true,
        true,
    ]);

    await sendTransaction(
        "PoolFactory",
        poolFactory,
        "setFees",
        [1, 0, 0, 1100, 0, 100, 0, 0, 0, 0],
    );

    await sendTransaction("PoolFactory", poolFactory, "addPoolOperator", [
        1,
        "0xFE8364850C10141E64B8cb50bEb370B511DEC95f",
    ]);

    await sendTransaction("PoolFactory", poolFactory, "setPoolEvaluationAgent", [
        1,
        "0x1d0952dbe8351477125a31da857e8b148f04372d",
    ]);

    await sendTransaction("PoolFactory", poolFactory, "setPoolOwnerTreasury", [
        1,
        "0x73285f0013f76366e0442180c5ae3a67da2ab4fc",
    ]);
}

async function addTimeLock() {
    const poolFactory = await hre.ethers.getContractAt(
        "PoolFactory",
        deployedContracts["PoolFactory"],
    );
    await sendTransaction("PoolFactory", poolFactory, "addTimelock", [
        1,
        [deployer.address],
        ["0x73285f0013F76366e0442180C5Ae3A67Da2ab4fC"],
    ]);
}

async function addOwnership() {
    const poolFactory = await hre.ethers.getContractAt(
        "PoolFactory",
        deployedContracts["PoolFactory"],
    );
    await sendTransaction("PoolFactory", poolFactory, "addPoolOwner", [1, deployer.address]);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
