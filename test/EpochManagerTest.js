const {ethers} = require("hardhat");
const {expect} = require("chai");
const {BigNumber: BN} = require("ethers");
const {loadFixture} = require("@nomicfoundation/hardhat-network-helpers");
const {
    deployProtocolContracts,
    deployAndSetupPoolContracts,
    CONSTANTS,
    getNextDueDate,
    checkEpochInfo,
} = require("./BaseTest");
const {toToken, mineNextBlockWithTimestamp} = require("./TestUtils");
const moment = require("moment");

let defaultDeployer, protocolOwner, treasury, eaServiceAccount, pdsServiceAccount;
let poolOwner, poolOwnerTreasury, evaluationAgent, poolOperator;
let lender, lender2;

let eaNFTContract, humaConfigContract, mockTokenContract;
let poolConfigContract,
    platformFeeManagerContract,
    poolVaultContract,
    calendarContract,
    lossCovererContract,
    tranchesPolicyContract,
    poolContract,
    epochManagerContract,
    seniorTrancheVaultContract,
    juniorTrancheVaultContract,
    creditContract;

// function getNextEpochEndTime(currentDate, calendarUnit, countInCalendarUnit) {
//     let date;
//     if (calendarUnit === 0) {
//         date = moment.utc(moment.unix(currentDate).utc().format("YYYY-MM-DD"));
//         date = date.add(countInCalendarUnit + 1, "days");
//     } else if (calendarUnit === 1) {
//         date = moment.utc(moment.unix(currentDate).utc().format("YYYY-MM-01"));
//         date = date.add(countInCalendarUnit + 1, "months");
//     }
//     return date.unix();
// }

describe("EpochManager Test", function () {
    before(async function () {
        [
            defaultDeployer,
            protocolOwner,
            treasury,
            eaServiceAccount,
            pdsServiceAccount,
            poolOwner,
            poolOwnerTreasury,
            evaluationAgent,
            poolOperator,
            lender,
            lender2,
        ] = await ethers.getSigners();
    });

    async function prepare() {
        [eaNFTContract, humaConfigContract, mockTokenContract] = await deployProtocolContracts(
            protocolOwner,
            treasury,
            eaServiceAccount,
            pdsServiceAccount,
            poolOwner
        );

        [
            poolConfigContract,
            platformFeeManagerContract,
            poolVaultContract,
            calendarContract,
            lossCovererContract,
            tranchesPolicyContract,
            poolContract,
            epochManagerContract,
            seniorTrancheVaultContract,
            juniorTrancheVaultContract,
            creditContract,
        ] = await deployAndSetupPoolContracts(
            humaConfigContract,
            mockTokenContract,
            eaNFTContract,
            "RiskAdjustedTranchesPolicy",
            defaultDeployer,
            poolOwner,
            evaluationAgent,
            poolOwnerTreasury,
            poolOperator,
            [lender, lender2]
        );

        let juniorDepositAmount = toToken(400_000);
        await juniorTrancheVaultContract
            .connect(lender)
            .deposit(juniorDepositAmount, lender.address);
        let seniorDepositAmount = toToken(10_000);
        await seniorTrancheVaultContract
            .connect(lender)
            .deposit(seniorDepositAmount, lender.address);

        juniorDepositAmount = toToken(50_000);
        await juniorTrancheVaultContract
            .connect(lender2)
            .deposit(juniorDepositAmount, lender2.address);
        seniorDepositAmount = toToken(20_000);
        await seniorTrancheVaultContract
            .connect(lender2)
            .deposit(seniorDepositAmount, lender2.address);

        // console.log(
        //     `juniorTrancheVaultContract.totalAssets: ${await juniorTrancheVaultContract.totalAssets()}`
        // );
        // console.log(
        //     `seniorTrancheVaultContract.totalAssets: ${await seniorTrancheVaultContract.totalAssets()}`
        // );
    }

    beforeEach(async function () {
        await loadFixture(prepare);
    });

    it("Should not allow non-Pool to start new epoch", async function () {
        await expect(epochManagerContract.startNewEpoch()).to.be.revertedWithCustomError(
            poolConfigContract,
            "notPool"
        );
    });

    it("Should start new epoch", async function () {
        let settings = await poolConfigContract.getPoolSettings();

        // Starts a new epoch
        let lastEpoch = await epochManagerContract.currentEpoch();
        let [endTime] = getNextDueDate(
            settings.calendarUnit,
            0,
            Math.ceil(Date.now() / 1000),
            settings.epochWindowInCalendarUnit
        );
        await expect(poolContract.connect(poolOwner).enablePool())
            .to.emit(epochManagerContract, "NewEpochStarted")
            .withArgs(lastEpoch.id.toNumber() + 1, endTime);

        // Goes forward one day and start a new epoch
        let ts = endTime + 60 * 5;
        await mineNextBlockWithTimestamp(ts);
        lastEpoch = await epochManagerContract.currentEpoch();
        [endTime] = getNextDueDate(
            settings.calendarUnit,
            0,
            ts,
            settings.epochWindowInCalendarUnit
        );
        await expect(poolContract.connect(poolOwner).enablePool())
            .to.emit(epochManagerContract, "NewEpochStarted")
            .withArgs(lastEpoch.id.toNumber() + 1, endTime);
    });

    it("Should not close epoch while protocol is paused or pool is not on", async function () {
        await humaConfigContract.connect(protocolOwner).pause();
        await expect(epochManagerContract.closeEpoch()).to.be.revertedWithCustomError(
            poolConfigContract,
            "protocolIsPaused"
        );
        await humaConfigContract.connect(protocolOwner).unpause();

        await poolContract.connect(poolOwner).disablePool();
        await expect(epochManagerContract.closeEpoch()).to.be.revertedWithCustomError(
            poolConfigContract,
            "poolIsNotOn"
        );
        await poolContract.connect(poolOwner).enablePool();
    });

    it("Should not close epoch before end time", async function () {
        await expect(epochManagerContract.closeEpoch()).to.be.revertedWithCustomError(
            epochManagerContract,
            "closeTooSoon"
        );
    });

    it("Should close epoch successfully while processing one epoch fully", async function () {
        let settings = await poolConfigContract.getPoolSettings();

        let withdrawalShares = toToken(1000);
        await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(withdrawalShares);
        await seniorTrancheVaultContract.connect(lender2).addRedemptionRequest(withdrawalShares);

        let lastEpoch = await epochManagerContract.currentEpoch();
        let ts = lastEpoch.endTime.toNumber() + 60 * 5;
        await mineNextBlockWithTimestamp(ts);
        let [endTime] = getNextDueDate(
            settings.calendarUnit,
            lastEpoch.endTime.toNumber(),
            ts,
            settings.epochWindowInCalendarUnit
        );

        let juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();
        let juniorTotalSupply = await juniorTrancheVaultContract.totalSupply();
        let juniorBalance = await mockTokenContract.balanceOf(juniorTrancheVaultContract.address);

        let seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
        let seniorTotalSupply = await seniorTrancheVaultContract.totalSupply();
        let seniorBalance = await mockTokenContract.balanceOf(seniorTrancheVaultContract.address);

        await expect(epochManagerContract.closeEpoch())
            .to.emit(epochManagerContract, "EpochClosed")
            .withArgs(
                lastEpoch.id,
                seniorTotalAssets.sub(withdrawalShares),
                1,
                juniorTotalAssets.sub(withdrawalShares),
                1,
                0
            )
            .to.emit(epochManagerContract, "NewEpochStarted")
            .withArgs(lastEpoch.id.toNumber() + 1, endTime)
            .to.emit(seniorTrancheVaultContract, "EpochsProcessed")
            .withArgs(1, withdrawalShares, withdrawalShares, 1)
            .to.emit(juniorTrancheVaultContract, "EpochsProcessed")
            .withArgs(1, withdrawalShares, withdrawalShares, 1);

        expect(await juniorTrancheVaultContract.totalSupply()).to.equal(
            juniorTotalSupply.sub(withdrawalShares)
        );
        expect(await mockTokenContract.balanceOf(juniorTrancheVaultContract.address)).to.equal(
            juniorBalance.add(withdrawalShares)
        );
        expect(await seniorTrancheVaultContract.totalSupply()).to.equal(
            seniorTotalSupply.sub(withdrawalShares)
        );
        expect(await mockTokenContract.balanceOf(seniorTrancheVaultContract.address)).to.equal(
            seniorBalance.add(withdrawalShares)
        );

        let epoch = await seniorTrancheVaultContract.epochMap(1);
        checkEpochInfo(epoch, 1, withdrawalShares, withdrawalShares, withdrawalShares);
        epoch = await juniorTrancheVaultContract.epochMap(1);
        checkEpochInfo(epoch, 1, withdrawalShares, withdrawalShares, withdrawalShares);

        let res = await seniorTrancheVaultContract.unprocessedEpochInfos();
        expect(res.length).to.equal(0);
        res = await juniorTrancheVaultContract.unprocessedEpochInfos();
        expect(res.length).to.equal(0);
    });
});
