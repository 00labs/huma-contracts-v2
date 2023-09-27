import { ethers } from "hardhat";
import { expect } from "chai";
import { BigNumber as BN } from "ethers";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import {
    checkCreditConfig,
    checkCreditRecord,
    CONSTANTS,
    deployAndSetupPoolContracts,
    deployProtocolContracts,
    checkPnLTracker,
    checkTwoCreditRecords,
    printCreditRecord,
    checkCreditLoss,
    checkTwoCreditLosses,
} from "../BaseTest";
import {
    getNextTime,
    getNextMonth,
    getNextDate,
    getStartDateOfPeriod,
    mineNextBlockWithTimestamp,
    toToken,
    getLatestBlock,
    timestampToMoment,
} from "../TestUtils";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import {
    BaseCreditFeeManager,
    BasePnLManager,
    Calendar,
    CreditLine,
    EpochManager,
    EvaluationAgentNFT,
    FirstLossCover,
    HumaConfig,
    MockToken,
    PoolFeeManager,
    Pool,
    PoolConfig,
    PoolSafe,
    ProfitEscrow,
    RiskAdjustedTranchesPolicy,
    TrancheVault,
} from "../../typechain-types";
import { CreditRecordStructOutput } from "../../typechain-types/contracts/credit/utils/interfaces/ICreditFeeManager";
import { CreditConfigStructOutput } from "../../typechain-types/contracts/credit/BaseCredit";
import { FeeStructureStructOutput } from "../../typechain-types/contracts/PoolConfig";

let defaultDeployer: SignerWithAddress,
    protocolOwner: SignerWithAddress,
    treasury: SignerWithAddress,
    eaServiceAccount: SignerWithAddress,
    pdsServiceAccount: SignerWithAddress;
let poolOwner: SignerWithAddress,
    poolOwnerTreasury: SignerWithAddress,
    evaluationAgent: SignerWithAddress,
    poolOperator: SignerWithAddress;
let lender: SignerWithAddress, borrower: SignerWithAddress, borrower2: SignerWithAddress;

let eaNFTContract: EvaluationAgentNFT,
    humaConfigContract: HumaConfig,
    mockTokenContract: MockToken;
let poolConfigContract: PoolConfig,
    poolFeeManagerContract: PoolFeeManager,
    poolSafeContract: PoolSafe,
    calendarContract: Calendar,
    borrowerFirstLossCover: FirstLossCover,
    affiliateFeeManagerContract: FirstLossCover,
    affiliateFirstLossCoverProfitEscrowContract: ProfitEscrow,
    tranchesPolicyContract: RiskAdjustedTranchesPolicy,
    poolContract: Pool,
    epochManagerContract: EpochManager,
    seniorTrancheVaultContract: TrancheVault,
    juniorTrancheVaultContract: TrancheVault,
    creditContract: CreditLine,
    creditFeeManagerContract: BaseCreditFeeManager,
    creditPnlManagerContract: BasePnLManager;

function calcLossRate(cr: CreditRecordStructOutput, defaultPeriod: number): [BN, number] {
    let [defaultDate] = getNextMonth(
        cr.nextDueDate.toNumber(),
        cr.nextDueDate.toNumber(),
        defaultPeriod,
    );
    let principal = getPrincipal(cr);
    let lossRate = principal
        .mul(CONSTANTS.DEFAULT_DECIMALS_FACTOR)
        .div(BN.from(defaultDate).sub(cr.nextDueDate));
    return [lossRate, defaultDate];
}

function calcProfitRateWithCR(cr: CreditRecordStructOutput, yieldInBps: number): BN {
    let principal = getPrincipal(cr);
    return calcProfitRateWithPrincipal(principal, yieldInBps);
}

function calcProfitRateWithPrincipal(principal: BN, yieldInBps: number): BN {
    let profitRate = principal
        .mul(BN.from(yieldInBps))
        .mul(CONSTANTS.DEFAULT_DECIMALS_FACTOR)
        .div(CONSTANTS.BP_FACTOR.mul(CONSTANTS.SECONDS_IN_YEAR));

    return profitRate;
}

function calcYield(principal: BN, yieldInBps: number, seconds: number): BN {
    return principal
        .mul(BN.from(yieldInBps))
        .mul(BN.from(seconds))
        .div(BN.from(CONSTANTS.SECONDS_IN_YEAR).mul(CONSTANTS.BP_FACTOR));
}

function calcLateFee(configs: BN[], principal: BN): BN {
    let fees = configs[0];
    if (configs[1].gt(0)) {
        fees = fees.add(principal.mul(configs[1]).div(CONSTANTS.BP_FACTOR));
    }
    return fees;
}

function getPrincipal(cr: CreditRecordStructOutput): BN {
    return cr.unbilledPrincipal.add(cr.totalDue.sub(cr.yieldDue).sub(cr.feesDue));
}

function calcLateCreditRecord(
    cr: CreditRecordStructOutput,
    cc: CreditConfigStructOutput,
    periodCount: number,
    currentTime: number,
    configs: BN[],
): [CreditRecordStructOutput, BN, BN] {
    let ncr = { ...cr };
    let principalDiff = BN.from(0);
    let missProfit = BN.from(0);
    let preDueDate = 0;

    // console.log(`currentTime: ${currentTime}`);

    for (let i = 0; i < periodCount; i++) {
        let [nextDueDate] = getNextMonth(
            ncr.nextDueDate.toNumber(),
            ncr.nextDueDate.toNumber(),
            cc.periodDuration,
        );
        let seconds = nextDueDate - ncr.nextDueDate.toNumber();

        // console.log(`nextDueDate: ${nextDueDate}, seconds: ${seconds}`);

        // console.log(
        //     `ncr.totalDue: ${ncr.totalDue}, ncr.unbilledPrincipal: ${ncr.unbilledPrincipal}`,
        // );

        if (ncr.totalDue.gt(BN.from(0))) {
            ncr.unbilledPrincipal = ncr.unbilledPrincipal.add(ncr.totalDue);
            principalDiff = principalDiff.add(ncr.totalDue);
            missProfit = missProfit.add(ncr.feesDue);
            ncr.feesDue = calcLateFee(configs, ncr.unbilledPrincipal);

            // console.log(
            //     `ncr.feesDue: ${ncr.feesDue}, ncr.unbilledPrincipal: ${ncr.unbilledPrincipal}, principalDiff: ${principalDiff}`,
            // );
        }

        ncr.yieldDue = calcYield(ncr.unbilledPrincipal, cc.yieldInBps, seconds);

        // console.log(`ncr.yieldDue: ${ncr.yieldDue}`);

        ncr.feesDue = ncr.feesDue.add(configs[2]);

        // console.log(`ncr.feesDue: ${ncr.feesDue}`);

        let principalToBill = ncr.unbilledPrincipal.mul(configs[3]).div(CONSTANTS.BP_FACTOR);
        ncr.totalDue = ncr.yieldDue.add(ncr.feesDue).add(principalToBill);
        ncr.unbilledPrincipal = ncr.unbilledPrincipal.sub(principalToBill);

        // console.log(
        //     `ncr.totalDue: ${ncr.totalDue}, ncr.unbilledPrincipal: ${ncr.unbilledPrincipal}, principalDiff: ${principalDiff}`,
        // );

        if (principalDiff.gt(BN.from(0)) && currentTime > nextDueDate) {
            missProfit = missProfit.add(calcYield(principalDiff, cc.yieldInBps, seconds));
            // console.log(`missProfit: ${missProfit}`);
        }

        preDueDate = ncr.nextDueDate.toNumber();
        ncr.nextDueDate = BN.from(nextDueDate);
    }
    if (currentTime > preDueDate) {
        missProfit = missProfit.add(
            calcYield(principalDiff, cc.yieldInBps, currentTime - preDueDate),
        );
        // console.log(`missProfit: ${missProfit}`);
    }

    ncr.remainingPeriods = ncr.remainingPeriods - periodCount;
    ncr.missedPeriods = ncr.missedPeriods + periodCount;

    if (ncr.remainingPeriods === 0) {
        ncr.totalDue = ncr.totalDue.add(ncr.unbilledPrincipal);
        ncr.unbilledPrincipal = BN.from(0);
    }

    ncr.state = 5;

    return [ncr, principalDiff, missProfit];
}

async function getCreditRecordSettings(): Promise<BN[]> {
    let settings = Array<BN>();
    let fees = await poolConfigContract.getFees();
    settings.push(fees[0]);
    settings.push(fees[1]);
    settings.push(fees[2]);
    settings.push(await poolConfigContract.getMinPrincipalRateInBps());
    return settings;
}

describe("CreditLine Test", function () {
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
            borrower,
            borrower2,
        ] = await ethers.getSigners();
    });

    async function prepare() {
        [eaNFTContract, humaConfigContract, mockTokenContract] = await deployProtocolContracts(
            protocolOwner,
            treasury,
            eaServiceAccount,
            pdsServiceAccount,
            poolOwner,
        );

        [
            poolConfigContract,
            poolFeeManagerContract,
            poolSafeContract,
            calendarContract,
            borrowerFirstLossCover,
            affiliateFeeManagerContract,
            affiliateFirstLossCoverProfitEscrowContract,
            tranchesPolicyContract,
            poolContract,
            epochManagerContract,
            seniorTrancheVaultContract,
            juniorTrancheVaultContract,
            creditContract as unknown,
            creditFeeManagerContract,
            creditPnlManagerContract,
        ] = await deployAndSetupPoolContracts(
            humaConfigContract,
            mockTokenContract,
            eaNFTContract,
            "RiskAdjustedTranchesPolicy",
            defaultDeployer,
            poolOwner,
            "CreditLine",
            evaluationAgent,
            poolOwnerTreasury,
            poolOperator,
            [lender, borrower, borrower2],
        );

        await borrowerFirstLossCover.connect(poolOwner).setOperator(borrower.address, {
            poolCapCoverageInBps: 1,
            poolValueCoverageInBps: 100,
        });

        await borrowerFirstLossCover.connect(borrower).depositCover(toToken(200_000));

        await borrowerFirstLossCover.connect(poolOwner).setOperator(borrower2.address, {
            poolCapCoverageInBps: 1,
            poolValueCoverageInBps: 100,
        });

        await borrowerFirstLossCover.connect(borrower2).depositCover(toToken(200_000));
    }

    beforeEach(async function () {
        await loadFixture(prepare);
    });

    describe("Approve Tests", function () {
        it("Should not approve while protocol is paused or pool is not on", async function () {
            await humaConfigContract.connect(protocolOwner).pause();
            await expect(
                creditContract
                    .connect(eaServiceAccount)
                    .approveBorrower(
                        borrower.address,
                        toToken(10_000),
                        1,
                        1217,
                        toToken(10_000),
                        true,
                    ),
            ).to.be.revertedWithCustomError(poolConfigContract, "protocolIsPaused");
            await humaConfigContract.connect(protocolOwner).unpause();

            await poolContract.connect(poolOwner).disablePool();
            await expect(
                creditContract
                    .connect(eaServiceAccount)
                    .approveBorrower(
                        borrower.address,
                        toToken(10_000),
                        1,
                        1217,
                        toToken(10_000),
                        true,
                    ),
            ).to.be.revertedWithCustomError(poolConfigContract, "poolIsNotOn");
            await poolContract.connect(poolOwner).enablePool();
        });

        it("Should not allow non-EA service account to approve", async function () {
            await expect(
                creditContract.approveBorrower(
                    borrower.address,
                    toToken(10_000),
                    1,
                    1217,
                    toToken(10_000),
                    true,
                ),
            ).to.be.revertedWithCustomError(
                creditContract,
                "evaluationAgentServiceAccountRequired",
            );
        });

        it("Should not approve with invalid parameters", async function () {
            await expect(
                creditContract
                    .connect(eaServiceAccount)
                    .approveBorrower(
                        ethers.constants.AddressZero,
                        toToken(10_000),
                        1,
                        1217,
                        toToken(10_000),
                        true,
                    ),
            ).to.be.revertedWithCustomError(creditContract, "zeroAddressProvided");

            await expect(
                creditContract
                    .connect(eaServiceAccount)
                    .approveBorrower(borrower.address, toToken(0), 1, 1217, toToken(10_000), true),
            ).to.be.revertedWithCustomError(creditContract, "zeroAmountProvided");

            await expect(
                creditContract
                    .connect(eaServiceAccount)
                    .approveBorrower(
                        borrower.address,
                        toToken(10_000),
                        0,
                        1217,
                        toToken(10_000),
                        true,
                    ),
            ).to.be.revertedWithCustomError(creditContract, "zeroPayPeriods");

            await expect(
                creditContract
                    .connect(eaServiceAccount)
                    .approveBorrower(
                        borrower.address,
                        toToken(10_000),
                        1,
                        1217,
                        toToken(10_001),
                        true,
                    ),
            ).to.be.revertedWithCustomError(creditContract, "committedAmountGreatThanCreditLimit");

            let poolSettings = await poolConfigContract.getPoolSettings();
            let creditLimit = poolSettings.maxCreditLine.add(1);

            await expect(
                creditContract
                    .connect(eaServiceAccount)
                    .approveBorrower(
                        borrower.address,
                        creditLimit,
                        1,
                        1217,
                        toToken(10_000),
                        true,
                    ),
            ).to.be.revertedWithCustomError(creditContract, "greaterThanMaxCreditLine");
        });

        it("Should not approve while credit line is in wrong state", async function () {
            await creditContract
                .connect(eaServiceAccount)
                .approveBorrower(
                    borrower.address,
                    toToken(10_000),
                    1,
                    1217,
                    toToken(10_000),
                    true,
                );

            await expect(
                creditContract
                    .connect(eaServiceAccount)
                    .approveBorrower(
                        borrower.address,
                        toToken(10_000),
                        1,
                        1217,
                        toToken(10_000),
                        true,
                    ),
            ).to.be.revertedWithCustomError(creditContract, "creditLineNotInStateForUpdate");
        });

        it("Should approve a borrower correctly", async function () {
            const creditHash = ethers.utils.keccak256(
                ethers.utils.defaultAbiCoder.encode(
                    ["address", "address"],
                    [creditContract.address, borrower.address],
                ),
            );

            let poolSettings = await poolConfigContract.getPoolSettings();

            await expect(
                creditContract
                    .connect(eaServiceAccount)
                    .approveBorrower(
                        borrower.address,
                        toToken(10_000),
                        1,
                        1217,
                        toToken(10_000),
                        true,
                    ),
            )
                .to.emit(creditContract, "CreditConfigChanged")
                .withArgs(
                    creditHash,
                    toToken(10_000),
                    toToken(10_000),
                    poolSettings.calendarUnit,
                    poolSettings.payPeriodInCalendarUnit,
                    1,
                    1217,
                    true,
                    false,
                    false,
                    false,
                )
                .to.emit(creditContract, "CreditLineApproved")
                .withArgs(
                    borrower.address,
                    creditHash,
                    toToken(10_000),
                    1,
                    1217,
                    toToken(10_000),
                    true,
                );

            let creditConfig = await creditContract.creditConfigMap(creditHash);
            checkCreditConfig(
                creditConfig,
                toToken(10_000),
                toToken(10_000),
                poolSettings.calendarUnit,
                poolSettings.payPeriodInCalendarUnit,
                1,
                1217,
                true,
                false,
                false,
                false,
            );

            let creditRecord = await creditContract.creditRecordMap(creditHash);
            checkCreditRecord(
                creditRecord,
                BN.from(0),
                0,
                BN.from(0),
                BN.from(0),
                BN.from(0),
                0,
                1,
                3,
            );
        });
    });

    describe("Drawdown Tests", function () {
        it("Should not drawdown with invalid parameters", async function () {
            // borrower == 0
            // borrowAmount == 0
        });

        it("Should not drawdown while credit line is in wrong state", async function () {});

        it("Should not borrow after credit expiration window", async function () {
            // await poolConfigContract.connect(poolOwner).setCreditApprovalExpiration(5);
            // await poolContract
            //     .connect(eaServiceAccount)
            //     .approveCredit(borrower.address, toToken(1_000_000), 30, 12, 1217);
            // await advanceClock(6);
            // await expect(
            //     poolContract.connect(borrower).drawdown(toToken(1_000_000))
            // ).to.revertedWithCustomError(poolContract, "creditExpiredDueToFirstDrawdownTooLate");
        });

        it("Should not borrow after credit expired", async function () {});

        it("Should not borrow while credit limit is exceeded after updateDueInfo", async function () {});

        it("Should not borrow while borrow amount exceeds front loading fees after updateDueInfo", async function () {});

        it("Should borrow first time successfully", async function () {
            let frontLoadingFeeBps = BN.from(100);
            await poolConfigContract.connect(poolOwner).setFrontLoadingFees({
                frontLoadingFeeFlat: 0,
                frontLoadingFeeBps: frontLoadingFeeBps,
            });

            await poolConfigContract
                .connect(poolOwner)
                .setPoolPayPeriod(CONSTANTS.CALENDAR_UNIT_MONTH, 1);

            let juniorDepositAmount = toToken(300_000);
            await juniorTrancheVaultContract
                .connect(lender)
                .deposit(juniorDepositAmount, lender.address);
            let seniorDepositAmount = toToken(100_000);
            await seniorTrancheVaultContract
                .connect(lender)
                .deposit(seniorDepositAmount, lender.address);

            const yieldInBps = 1217;
            await creditContract
                .connect(eaServiceAccount)
                .approveBorrower(
                    borrower.address,
                    toToken(100_000),
                    3,
                    yieldInBps,
                    toToken(100_000),
                    true,
                );

            const creditHash = ethers.utils.keccak256(
                ethers.utils.defaultAbiCoder.encode(
                    ["address", "address"],
                    [creditContract.address, borrower.address],
                ),
            );

            let borrowAmount = toToken(50_000);
            let netBorrowAmount = borrowAmount
                .mul(CONSTANTS.BP_FACTOR.sub(frontLoadingFeeBps))
                .div(CONSTANTS.BP_FACTOR);
            let nextTime = await getNextTime(3);
            await mineNextBlockWithTimestamp(nextTime);

            let [nextDueDate] = getNextMonth(0, nextTime, 1);
            let yieldDue = calcYield(borrowAmount, yieldInBps, nextDueDate - nextTime);

            let beforeBalance = await mockTokenContract.balanceOf(borrower.address);
            await expect(creditContract.connect(borrower).drawdown(borrower.address, borrowAmount))
                .to.emit(creditContract, "DrawdownMade")
                .withArgs(borrower.address, borrowAmount, netBorrowAmount)
                .to.emit(creditContract, "BillRefreshed")
                .withArgs(creditHash, nextDueDate, yieldDue);
            let afterBalance = await mockTokenContract.balanceOf(borrower.address);
            expect(afterBalance.sub(beforeBalance)).to.equal(netBorrowAmount);

            let creditRecord = await creditContract.creditRecordMap(creditHash);
            checkCreditRecord(
                creditRecord,
                borrowAmount,
                nextDueDate,
                yieldDue,
                yieldDue,
                BN.from(0),
                0,
                2,
                4,
            );

            let pnlTracker = await creditPnlManagerContract.getPnL();
            checkPnLTracker(
                pnlTracker,
                borrowAmount
                    .mul(yieldInBps)
                    .mul(CONSTANTS.DEFAULT_DECIMALS_FACTOR)
                    .div(CONSTANTS.BP_FACTOR)
                    .div(CONSTANTS.SECONDS_IN_YEAR),
                BN.from(0),
                nextTime,
                borrowAmount.mul(frontLoadingFeeBps).div(CONSTANTS.BP_FACTOR),
                BN.from(0),
                BN.from(0),
            );
        });

        it("Should borrow second time in the same period successfully", async function () {
            let frontLoadingFeeBps = BN.from(100);
            await poolConfigContract.connect(poolOwner).setFrontLoadingFees({
                frontLoadingFeeFlat: 0,
                frontLoadingFeeBps: frontLoadingFeeBps,
            });

            await poolConfigContract
                .connect(poolOwner)
                .setPoolPayPeriod(CONSTANTS.CALENDAR_UNIT_MONTH, 3);

            let juniorDepositAmount = toToken(300_000);
            await juniorTrancheVaultContract
                .connect(lender)
                .deposit(juniorDepositAmount, lender.address);
            let seniorDepositAmount = toToken(100_000);
            await seniorTrancheVaultContract
                .connect(lender)
                .deposit(seniorDepositAmount, lender.address);

            const yieldInBps = 1217;
            await creditContract
                .connect(eaServiceAccount)
                .approveBorrower(
                    borrower.address,
                    toToken(100_000),
                    3,
                    yieldInBps,
                    toToken(100_000),
                    true,
                );

            const creditHash = ethers.utils.keccak256(
                ethers.utils.defaultAbiCoder.encode(
                    ["address", "address"],
                    [creditContract.address, borrower.address],
                ),
            );

            let borrowAmount = toToken(30_000);
            let allBorrowAmount = borrowAmount;
            let netBorrowAmount = borrowAmount
                .mul(CONSTANTS.BP_FACTOR.sub(frontLoadingFeeBps))
                .div(CONSTANTS.BP_FACTOR);
            let nextTime = await getNextTime(3);
            await mineNextBlockWithTimestamp(nextTime);

            let [nextDueDate] = getNextMonth(0, nextTime, 3);
            let yieldDue = calcYield(borrowAmount, yieldInBps, nextDueDate - nextTime);

            let userBeforeBalance = await mockTokenContract.balanceOf(borrower.address);
            let pvBeforeBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
            await expect(creditContract.connect(borrower).drawdown(borrower.address, borrowAmount))
                .to.emit(creditContract, "DrawdownMade")
                .withArgs(borrower.address, borrowAmount, netBorrowAmount)
                .to.emit(creditContract, "BillRefreshed")
                .withArgs(creditHash, nextDueDate, yieldDue);
            let userAfterBalance = await mockTokenContract.balanceOf(borrower.address);
            let pvAfterBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
            expect(userAfterBalance.sub(userBeforeBalance)).to.equal(netBorrowAmount);
            expect(pvBeforeBalance.sub(pvAfterBalance)).to.equal(netBorrowAmount);

            let creditRecord = await creditContract.creditRecordMap(creditHash);
            // console.log(`creditRecord: ${creditRecord}`);
            checkCreditRecord(
                creditRecord,
                borrowAmount,
                nextDueDate,
                yieldDue,
                yieldDue,
                BN.from(0),
                0,
                2,
                4,
            );

            let pnlTracker = await creditPnlManagerContract.getPnL();
            checkPnLTracker(
                pnlTracker,
                borrowAmount
                    .mul(yieldInBps)
                    .mul(CONSTANTS.DEFAULT_DECIMALS_FACTOR)
                    .div(CONSTANTS.BP_FACTOR)
                    .div(CONSTANTS.SECONDS_IN_YEAR),
                BN.from(0),
                nextTime,
                borrowAmount.mul(frontLoadingFeeBps).div(CONSTANTS.BP_FACTOR),
                BN.from(0),
                BN.from(0),
            );

            // move forward 10 days
            nextTime = nextTime + 3600 * 24 * 10;
            await mineNextBlockWithTimestamp(nextTime);

            borrowAmount = toToken(20_000);
            allBorrowAmount = allBorrowAmount.add(borrowAmount);
            netBorrowAmount = borrowAmount
                .mul(CONSTANTS.BP_FACTOR.sub(frontLoadingFeeBps))
                .div(CONSTANTS.BP_FACTOR);

            userBeforeBalance = await mockTokenContract.balanceOf(borrower.address);
            pvBeforeBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
            await expect(creditContract.connect(borrower).drawdown(borrower.address, borrowAmount))
                .to.emit(creditContract, "DrawdownMade")
                .withArgs(borrower.address, borrowAmount, netBorrowAmount);
            // .to.emit(creditContract, "BillRefreshed");
            // .withArgs(creditHash, nextDueDate, yieldDue);
            userAfterBalance = await mockTokenContract.balanceOf(borrower.address);
            pvAfterBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
            expect(userAfterBalance.sub(userBeforeBalance)).to.equal(netBorrowAmount);
            expect(pvBeforeBalance.sub(pvAfterBalance)).to.equal(netBorrowAmount);

            yieldDue = yieldDue.add(calcYield(borrowAmount, yieldInBps, nextDueDate - nextTime));
            creditRecord = await creditContract.creditRecordMap(creditHash);
            // console.log(`creditRecord: ${creditRecord}`);
            checkCreditRecord(
                creditRecord,
                allBorrowAmount,
                nextDueDate,
                yieldDue,
                yieldDue,
                BN.from(0),
                0,
                2,
                4,
            );

            let profitRate = pnlTracker.profitRate.add(
                borrowAmount
                    .mul(yieldInBps)
                    .mul(CONSTANTS.DEFAULT_DECIMALS_FACTOR)
                    .div(CONSTANTS.BP_FACTOR)
                    .div(CONSTANTS.SECONDS_IN_YEAR),
            );
            let accruedProfit = pnlTracker.accruedProfit
                .add(
                    pnlTracker.profitRate
                        .mul(BN.from(nextTime).sub(pnlTracker.pnlLastUpdated))
                        .div(CONSTANTS.DEFAULT_DECIMALS_FACTOR),
                )
                .add(borrowAmount.mul(frontLoadingFeeBps).div(CONSTANTS.BP_FACTOR));
            pnlTracker = await creditPnlManagerContract.getPnL();
            checkPnLTracker(
                pnlTracker,
                profitRate,
                BN.from(0),
                nextTime,
                accruedProfit,
                BN.from(0),
                BN.from(0),
            );
        });

        it("Should borrow second time after next due date and before grace late date", async function () {});
    });

    describe("MakePayment Tests", function () {
        const yieldInBps = 1217;
        const frontLoadingFeeBps = 100;
        const periodDuration = 2;

        let borrowAmount: BN, creditHash: string;

        async function prepareForMakePayment() {
            await poolConfigContract.connect(poolOwner).setFrontLoadingFees({
                frontLoadingFeeFlat: 0,
                frontLoadingFeeBps: frontLoadingFeeBps,
            });

            await poolConfigContract
                .connect(poolOwner)
                .setPoolPayPeriod(CONSTANTS.CALENDAR_UNIT_MONTH, periodDuration);

            let juniorDepositAmount = toToken(300_000);
            await juniorTrancheVaultContract
                .connect(lender)
                .deposit(juniorDepositAmount, lender.address);
            let seniorDepositAmount = toToken(100_000);
            await seniorTrancheVaultContract
                .connect(lender)
                .deposit(seniorDepositAmount, lender.address);

            await creditContract
                .connect(eaServiceAccount)
                .approveBorrower(
                    borrower.address,
                    toToken(100_000),
                    3,
                    yieldInBps,
                    toToken(100_000),
                    true,
                );

            borrowAmount = toToken(50_000);
            await creditContract.connect(borrower).drawdown(borrower.address, borrowAmount);

            creditHash = ethers.utils.keccak256(
                ethers.utils.defaultAbiCoder.encode(
                    ["address", "address"],
                    [creditContract.address, borrower.address],
                ),
            );
        }

        beforeEach(async function () {
            await loadFixture(prepareForMakePayment);
        });

        it("Should not approve while protocol is paused or pool is not on", async function () {
            await humaConfigContract.connect(protocolOwner).pause();
            await expect(
                creditContract.makePayment(borrower.address, toToken(1)),
            ).to.be.revertedWithCustomError(poolConfigContract, "protocolIsPaused");
            await humaConfigContract.connect(protocolOwner).unpause();

            await poolContract.connect(poolOwner).disablePool();
            await expect(
                creditContract.makePayment(borrower.address, toToken(1)),
            ).to.be.revertedWithCustomError(poolConfigContract, "poolIsNotOn");
            await poolContract.connect(poolOwner).enablePool();
        });

        it("Should not allow non-borrower or non-PDS service account to makePayment", async function () {});

        it("Should not makePayment with invalid parameters", async function () {});

        it("Should make payment partially payment successfully in GoodStanding state and before due date", async function () {});

        it("Should make payment partially payment successfully in GoodStanding state and between due date and grace late period", async function () {});

        it("Should make payment fully successfully in GoodStanding state and before due date", async function () {});

        it("Should make payment fully successfully in GoodStanding state and between due date and grace late period", async function () {});

        it("Should pay off successfully in GoodStanding state and before due date", async function () {});

        it("Should pay off successfully in GoodStanding state and between due date and grace late period", async function () {});
    });

    describe("RefreshCredit Tests", function () {
        const yieldInBps = 1217;
        const frontLoadingFeeBps = 100;
        const periodDuration = 2;
        let borrowAmount: BN, creditHash: string, borrowAmount2: BN, creditHash2: string;

        async function prepareForRefreshCredit() {
            await poolConfigContract.connect(poolOwner).setFrontLoadingFees({
                frontLoadingFeeFlat: 0,
                frontLoadingFeeBps: frontLoadingFeeBps,
            });

            await poolConfigContract
                .connect(poolOwner)
                .setPoolPayPeriod(CONSTANTS.CALENDAR_UNIT_MONTH, periodDuration);

            await poolConfigContract
                .connect(poolOwner)
                .setPoolDefaultGracePeriod(CONSTANTS.CALENDAR_UNIT_MONTH, periodDuration * 3);

            let juniorDepositAmount = toToken(300_000);
            await juniorTrancheVaultContract
                .connect(lender)
                .deposit(juniorDepositAmount, lender.address);
            let seniorDepositAmount = toToken(100_000);
            await seniorTrancheVaultContract
                .connect(lender)
                .deposit(seniorDepositAmount, lender.address);

            await creditContract
                .connect(eaServiceAccount)
                .approveBorrower(
                    borrower.address,
                    toToken(100_000),
                    5,
                    yieldInBps,
                    toToken(100_000),
                    true,
                );

            borrowAmount = toToken(10_000);
            await creditContract.connect(borrower).drawdown(borrower.address, borrowAmount);

            creditHash = ethers.utils.keccak256(
                ethers.utils.defaultAbiCoder.encode(
                    ["address", "address"],
                    [creditContract.address, borrower.address],
                ),
            );
        }

        beforeEach(async function () {
            await loadFixture(prepareForRefreshCredit);
        });

        it("Should not create new due info before due date", async function () {
            let creditRecord = await creditContract.creditRecordMap(creditHash);

            // move forward 10 days
            let nextTime = await getNextTime(3600 * 24 * 10);
            await mineNextBlockWithTimestamp(nextTime);

            let preCreditRecord = creditRecord;
            await creditContract.refreshCredit(borrower.address);
            creditRecord = await creditContract.creditRecordMap(creditHash);
            checkTwoCreditRecords(preCreditRecord, creditRecord);
        });

        it("Should not create new due info after due date and before grace late date", async function () {
            let creditRecord = await creditContract.creditRecordMap(creditHash);

            // move forward after due date and before grace late date
            let poolSettings = await poolConfigContract.getPoolSettings();
            let nextTime =
                creditRecord.nextDueDate.toNumber() +
                3600 * 24 * (poolSettings.latePaymentGracePeriodInDays - 1);
            await mineNextBlockWithTimestamp(nextTime);

            let preCreditRecord = creditRecord;
            await creditContract.refreshCredit(borrower.address);
            creditRecord = await creditContract.creditRecordMap(creditHash);
            checkTwoCreditRecords(preCreditRecord, creditRecord);
        });

        it("Should create new due info after grace late date", async function () {
            let creditRecord = await creditContract.creditRecordMap(creditHash);

            // move forward after grace late date
            let poolSettings = await poolConfigContract.getPoolSettings();
            let nextTime =
                creditRecord.nextDueDate.toNumber() +
                3600 * 24 * (poolSettings.latePaymentGracePeriodInDays + 1);
            await mineNextBlockWithTimestamp(nextTime);

            let preCreditRecord = creditRecord;
            await creditContract.refreshCredit(borrower.address);
            creditRecord = await creditContract.creditRecordMap(creditHash);
            printCreditRecord(`preCreditRecord`, preCreditRecord);
            printCreditRecord(`creditRecord`, creditRecord);

            let creditRecordSettings = await getCreditRecordSettings();
            let creditConfig = await creditContract.creditConfigMap(creditHash);
            let [newCreditRecord, principalDiff, missProfit] = calcLateCreditRecord(
                preCreditRecord,
                creditConfig,
                1,
                nextTime,
                creditRecordSettings,
            );
            printCreditRecord(`newCreditRecord`, newCreditRecord);
            checkTwoCreditRecords(creditRecord, newCreditRecord);

            let pnlTracker = await creditPnlManagerContract.getPnL();
            console.log(`pnlTracker: ${pnlTracker}`);

            let accruedProfit = preCreditRecord.yieldDue
                .add(
                    calcYield(
                        getPrincipal(creditRecord),
                        yieldInBps,
                        nextTime - preCreditRecord.nextDueDate.toNumber(),
                    ),
                )
                .add(borrowAmount.mul(frontLoadingFeeBps).div(CONSTANTS.BP_FACTOR));

            let profitRate = calcProfitRateWithCR(creditRecord, yieldInBps);
            console.log(`accruedProfit: ${accruedProfit}, profitRate: ${profitRate}`);

            let [originalLossRate, defaultDate] = calcLossRate(
                preCreditRecord,
                poolSettings.defaultGracePeriodInCalendarUnit,
            );
            let lossRate = originalLossRate.add(profitRate);

            let accruedLoss = BN.from(
                originalLossRate
                    .mul(BN.from(nextTime).sub(preCreditRecord.nextDueDate))
                    .div(CONSTANTS.DEFAULT_DECIMALS_FACTOR),
            )
                .add(getPrincipal(creditRecord).sub(getPrincipal(preCreditRecord)))
                .add(
                    calcYield(
                        getPrincipal(creditRecord),
                        yieldInBps,
                        nextTime -
                            getStartDateOfPeriod(
                                CONSTANTS.CALENDAR_UNIT_MONTH,
                                periodDuration,
                                creditRecord.nextDueDate.toNumber(),
                            ),
                    ),
                );
            console.log(
                `originalLossRate: ${originalLossRate}, lossRate: ${lossRate}, accruedLoss: ${accruedLoss}`,
            );

            checkPnLTracker(
                pnlTracker,
                profitRate,
                lossRate,
                nextTime,
                accruedProfit,
                accruedLoss,
                BN.from(0),
                1,
            );

            let creditLoss = await creditPnlManagerContract.getCreditLoss(creditHash);
            console.log(`creditLoss: ${creditLoss}`);

            checkCreditLoss(
                creditLoss,
                accruedLoss,
                BN.from(0),
                nextTime,
                defaultDate,
                lossRate,
                1,
            );
        });

        it("Should create new due info after multiple periods", async function () {
            let creditRecord = await creditContract.creditRecordMap(creditHash);

            // move forward after grace late date
            let poolSettings = await poolConfigContract.getPoolSettings();
            let nextTime =
                getNextMonth(
                    creditRecord.nextDueDate.toNumber(),
                    creditRecord.nextDueDate.toNumber(),
                    periodDuration,
                )[0] +
                60 * 10;
            await mineNextBlockWithTimestamp(nextTime);
            console.log(`nextTime: ${nextTime}`);

            let preCreditRecord = creditRecord;
            await creditContract.refreshCredit(borrower.address);
            creditRecord = await creditContract.creditRecordMap(creditHash);
            printCreditRecord(`preCreditRecord`, preCreditRecord);
            printCreditRecord(`creditRecord`, creditRecord);

            let creditRecordSettings = await getCreditRecordSettings();
            let creditConfig = await creditContract.creditConfigMap(creditHash);
            let [newCreditRecord, principalDiff, missProfit] = calcLateCreditRecord(
                preCreditRecord,
                creditConfig,
                2,
                nextTime,
                creditRecordSettings,
            );
            printCreditRecord(`newCreditRecord`, newCreditRecord);
            checkTwoCreditRecords(creditRecord, newCreditRecord);

            let pnlTracker = await creditPnlManagerContract.getPnL();
            console.log(`pnlTracker: ${pnlTracker}`);

            // accrued profit though multiple periods
            // 1. front loading fee
            // 2. current principal - borrow amount = accrued profit till last due date
            // 3. yield from start time of current period to current time
            let accruedProfit = BN.from(
                borrowAmount.mul(frontLoadingFeeBps).div(CONSTANTS.BP_FACTOR),
            )
                .add(getPrincipal(creditRecord).sub(borrowAmount))
                .add(
                    calcYield(
                        getPrincipal(creditRecord),
                        yieldInBps,
                        nextTime -
                            getStartDateOfPeriod(
                                CONSTANTS.CALENDAR_UNIT_MONTH,
                                periodDuration,
                                creditRecord.nextDueDate.toNumber(),
                            ),
                    ),
                );

            // profit rate = [principal of current due] * yieldInBps / [seconds in a year]
            let profitRate = calcProfitRateWithCR(creditRecord, yieldInBps);
            console.log(`accruedProfit: ${accruedProfit}, profitRate: ${profitRate}`);

            // original loss rate = [principal of the late due] / [default grace period length]
            let [originalLossRate, defaultDate] = calcLossRate(
                preCreditRecord,
                poolSettings.defaultGracePeriodInCalendarUnit,
            );

            // loss rate = [original loss rate] + [current profit rate]
            let lossRate = originalLossRate.add(profitRate);

            // accrued loss = [original loss part] + [profit part]
            // original loss part = [original loss rate] * [seconds till current time]
            // profit part = [profit from late due to current due]
            let accruedLoss = BN.from(
                originalLossRate
                    .mul(BN.from(nextTime).sub(preCreditRecord.nextDueDate))
                    .div(CONSTANTS.DEFAULT_DECIMALS_FACTOR),
            )
                .add(getPrincipal(creditRecord).sub(getPrincipal(preCreditRecord)))
                .add(
                    calcYield(
                        getPrincipal(creditRecord),
                        yieldInBps,
                        nextTime -
                            getStartDateOfPeriod(
                                CONSTANTS.CALENDAR_UNIT_MONTH,
                                periodDuration,
                                creditRecord.nextDueDate.toNumber(),
                            ),
                    ),
                );

            console.log(
                `originalLossRate: ${originalLossRate}, lossRate: ${lossRate}, accruedLoss: ${accruedLoss}`,
            );

            checkPnLTracker(
                pnlTracker,
                profitRate,
                lossRate,
                nextTime,
                accruedProfit,
                accruedLoss,
                BN.from(0),
                1,
            );

            let creditLoss = await creditPnlManagerContract.getCreditLoss(creditHash);
            // console.log(`creditLoss: ${creditLoss}`);
            checkCreditLoss(
                creditLoss,
                accruedLoss,
                BN.from(0),
                nextTime,
                defaultDate,
                lossRate,
                1,
            );
        });

        it("Should create new due info while credit state is delayed", async function () {
            let creditRecord = await creditContract.creditRecordMap(creditHash);

            // move forward after grace late date
            let poolSettings = await poolConfigContract.getPoolSettings();
            let nextTime =
                creditRecord.nextDueDate.toNumber() +
                3600 * 24 * (poolSettings.latePaymentGracePeriodInDays + 2);
            await mineNextBlockWithTimestamp(nextTime);

            let preCreditRecord = creditRecord;
            await creditContract.refreshCredit(borrower.address);
            creditRecord = await creditContract.creditRecordMap(creditHash);

            let creditRecordSettings = await getCreditRecordSettings();
            let creditConfig = await creditContract.creditConfigMap(creditHash);
            let [newCreditRecord, principalDiff, missProfit] = calcLateCreditRecord(
                preCreditRecord,
                creditConfig,
                1,
                nextTime,
                creditRecordSettings,
            );
            checkTwoCreditRecords(creditRecord, newCreditRecord);
            printCreditRecord(`preCreditRecord`, preCreditRecord);
            printCreditRecord(`creditRecord`, creditRecord);

            let [originalLossRate, defaultDate] = calcLossRate(
                preCreditRecord,
                poolSettings.defaultGracePeriodInCalendarUnit,
            );
            let lossStartDate = preCreditRecord.nextDueDate.toNumber();
            let lossStartPrincipal = getPrincipal(preCreditRecord);

            nextTime =
                getNextMonth(
                    preCreditRecord.nextDueDate.toNumber(),
                    preCreditRecord.nextDueDate.toNumber(),
                    2 * periodDuration,
                )[0] +
                60 * 10;
            await mineNextBlockWithTimestamp(nextTime);

            preCreditRecord = creditRecord;
            await creditContract.refreshCredit(borrower.address);
            creditRecord = await creditContract.creditRecordMap(creditHash);

            console.log(`nextTime: ${nextTime}`);
            printCreditRecord(`preCreditRecord`, preCreditRecord);
            printCreditRecord(`creditRecord`, creditRecord);

            [newCreditRecord, principalDiff, missProfit] = calcLateCreditRecord(
                preCreditRecord,
                creditConfig,
                2,
                nextTime,
                creditRecordSettings,
            );
            checkTwoCreditRecords(creditRecord, newCreditRecord);

            let pnlTracker = await creditPnlManagerContract.getPnL();
            console.log(`pnlTracker: ${pnlTracker}`);

            let accruedProfit = BN.from(
                borrowAmount.mul(frontLoadingFeeBps).div(CONSTANTS.BP_FACTOR),
            )
                .add(getPrincipal(creditRecord).sub(borrowAmount))
                .add(
                    calcYield(
                        getPrincipal(creditRecord),
                        yieldInBps,
                        nextTime -
                            getStartDateOfPeriod(
                                CONSTANTS.CALENDAR_UNIT_MONTH,
                                periodDuration,
                                creditRecord.nextDueDate.toNumber(),
                            ),
                    ),
                );

            let profitRate = calcProfitRateWithCR(creditRecord, yieldInBps);
            console.log(`accruedProfit: ${accruedProfit}, profitRate: ${profitRate}`);

            let lossRate = originalLossRate.add(profitRate);

            console.log(
                `lossStartPrincipal: ${lossStartPrincipal}, current principal: ${getPrincipal(
                    creditRecord,
                )}`,
            );

            let accruedLoss = BN.from(
                originalLossRate
                    .mul(BN.from(nextTime).sub(lossStartDate))
                    .div(CONSTANTS.DEFAULT_DECIMALS_FACTOR),
            )
                .add(getPrincipal(creditRecord).sub(lossStartPrincipal))
                .add(
                    calcYield(
                        getPrincipal(creditRecord),
                        yieldInBps,
                        nextTime -
                            getStartDateOfPeriod(
                                CONSTANTS.CALENDAR_UNIT_MONTH,
                                periodDuration,
                                creditRecord.nextDueDate.toNumber(),
                            ),
                    ),
                );

            console.log(
                `lossStartDate: ${lossStartDate}, nextTime: ${nextTime}, loss part1: ${originalLossRate
                    .mul(BN.from(nextTime).sub(lossStartDate))
                    .div(CONSTANTS.DEFAULT_DECIMALS_FACTOR)}`,
            );

            console.log(
                `originalLossRate: ${originalLossRate}, lossRate: ${lossRate}, accruedLoss: ${accruedLoss}`,
            );

            checkPnLTracker(
                pnlTracker,
                profitRate,
                lossRate,
                nextTime,
                accruedProfit,
                accruedLoss,
                BN.from(0),
                2,
            );

            let creditLoss = await creditPnlManagerContract.getCreditLoss(creditHash);
            // console.log(`creditLoss: ${creditLoss}`);
            checkCreditLoss(
                creditLoss,
                accruedLoss,
                BN.from(0),
                nextTime,
                defaultDate,
                lossRate,
                2,
            );
        });

        it("Should become defaulted after default grace periods", async function () {
            let creditRecord = await creditContract.creditRecordMap(creditHash);

            // move forward after grace late date
            let poolSettings = await poolConfigContract.getPoolSettings();
            let nextTime =
                creditRecord.nextDueDate.toNumber() +
                3600 * 24 * (poolSettings.latePaymentGracePeriodInDays + 1);
            await mineNextBlockWithTimestamp(nextTime);

            let preCreditRecord = creditRecord;
            await creditContract.refreshCredit(borrower.address);
            creditRecord = await creditContract.creditRecordMap(creditHash);

            let creditRecordSettings = await getCreditRecordSettings();
            let creditConfig = await creditContract.creditConfigMap(creditHash);
            let [newCreditRecord, principalDiff, missProfit] = calcLateCreditRecord(
                preCreditRecord,
                creditConfig,
                1,
                nextTime,
                creditRecordSettings,
            );
            // printCreditRecord(`preCreditRecord`, preCreditRecord);
            // printCreditRecord(`creditRecord`, creditRecord);
            checkTwoCreditRecords(creditRecord, newCreditRecord);

            let [originalLossRate, defaultDate] = calcLossRate(
                preCreditRecord,
                poolSettings.defaultGracePeriodInCalendarUnit,
            );
            let lossStartDate = preCreditRecord.nextDueDate.toNumber();
            let lossStartPrincipal = getPrincipal(preCreditRecord);

            let creditLoss = await creditPnlManagerContract.getCreditLoss(creditHash);
            console.log(`creditLoss: ${creditLoss}`);

            let lossRate = originalLossRate.add(calcProfitRateWithCR(creditRecord, yieldInBps));

            let accruedLoss = BN.from(
                originalLossRate
                    .mul(BN.from(nextTime).sub(lossStartDate))
                    .div(CONSTANTS.DEFAULT_DECIMALS_FACTOR),
            )
                .add(getPrincipal(creditRecord).sub(lossStartPrincipal))
                .add(
                    calcYield(
                        getPrincipal(creditRecord),
                        yieldInBps,
                        nextTime -
                            getStartDateOfPeriod(
                                CONSTANTS.CALENDAR_UNIT_MONTH,
                                periodDuration,
                                creditRecord.nextDueDate.toNumber(),
                            ),
                    ),
                );
            console.log(`accruedLoss: ${accruedLoss}, lossRate: ${lossRate}`);

            checkCreditLoss(
                creditLoss,
                accruedLoss,
                BN.from(0),
                nextTime,
                defaultDate,
                lossRate,
                1,
            );

            nextTime =
                getNextMonth(
                    preCreditRecord.nextDueDate.toNumber(),
                    preCreditRecord.nextDueDate.toNumber(),
                    3 * periodDuration,
                )[0] +
                60 * 5;
            await mineNextBlockWithTimestamp(nextTime);

            preCreditRecord = creditRecord;
            await creditContract.refreshCredit(borrower.address);
            creditRecord = await creditContract.creditRecordMap(creditHash);

            console.log(`nextTime: ${nextTime}`);
            printCreditRecord(`preCreditRecord`, preCreditRecord);
            printCreditRecord(`creditRecord`, creditRecord);

            [newCreditRecord, principalDiff, missProfit] = calcLateCreditRecord(
                preCreditRecord,
                creditConfig,
                3,
                nextTime,
                creditRecordSettings,
            );
            newCreditRecord.state = 6;
            checkTwoCreditRecords(creditRecord, newCreditRecord);

            let pnlTracker = await creditPnlManagerContract.getPnL();
            console.log(`pnlTracker: ${pnlTracker}`);

            let accruedProfit = BN.from(
                borrowAmount.mul(frontLoadingFeeBps).div(CONSTANTS.BP_FACTOR),
            ).add(getPrincipal(creditRecord).sub(borrowAmount));
            console.log(`accruedProfit: ${accruedProfit}`);

            accruedLoss = getPrincipal(creditRecord);
            console.log(`accruedLoss: ${accruedLoss}`);

            checkPnLTracker(
                pnlTracker,
                BN.from(0),
                BN.from(0),
                nextTime,
                accruedProfit,
                accruedLoss,
                BN.from(0),
                3,
            );

            creditLoss = await creditPnlManagerContract.getCreditLoss(creditHash);
            console.log(`creditLoss: ${creditLoss}`);
            checkCreditLoss(
                creditLoss,
                accruedLoss,
                BN.from(0),
                defaultDate,
                defaultDate,
                BN.from(0),
                3,
            );

            // credit doesn't change after default

            preCreditRecord = creditRecord;
            await creditContract.refreshCredit(borrower.address);
            creditRecord = await creditContract.creditRecordMap(creditHash);
            checkTwoCreditRecords(creditRecord, newCreditRecord);

            let preCreditLoss = creditLoss;
            creditLoss = await creditPnlManagerContract.getCreditLoss(creditHash);
            checkTwoCreditLosses(preCreditLoss, creditLoss);
        });

        it("Should refresh credit correctly with multiple credits, while setting late fee, membership fee and minPrincipalRateInBps", async function () {
            let creditRecord = await creditContract.creditRecordMap(creditHash);
            printCreditRecord(`creditRecord`, creditRecord);

            let profitRate = calcProfitRateWithCR(creditRecord, yieldInBps);
            let accruedProfit = borrowAmount.mul(frontLoadingFeeBps).div(CONSTANTS.BP_FACTOR);
            let block = await getLatestBlock();
            console.log(`accruedProfit: ${accruedProfit}`);

            let pnlTracker = await creditPnlManagerContract.getPnL();
            console.log(`pnlTracker: ${pnlTracker}`);

            checkPnLTracker(
                pnlTracker,
                profitRate,
                BN.from(0),
                block.timestamp,
                accruedProfit,
                BN.from(0),
                BN.from(0),
            );
            let preTime = block.timestamp;

            let lateFeeBps = 200;
            let membershipFee = toToken(100);
            let minPrincipalRateInBps = 1000;
            await poolConfigContract.connect(poolOwner).setFeeStructure({
                yieldInBps: yieldInBps,
                minPrincipalRateInBps: minPrincipalRateInBps,
                lateFeeFlat: BN.from(0),
                lateFeeBps: lateFeeBps,
                membershipFee: membershipFee,
            });

            await creditContract
                .connect(eaServiceAccount)
                .approveBorrower(
                    borrower2.address,
                    toToken(100_000),
                    5,
                    yieldInBps,
                    toToken(100_000),
                    true,
                );

            // move forward 30 days for borrower2 drawdown

            block = await getLatestBlock();
            let nextTime = timestampToMoment(block.timestamp).add(1, "months").unix();
            console.log(`nextTime: ${nextTime}`);
            await mineNextBlockWithTimestamp(nextTime);

            borrowAmount2 = toToken(15_000);
            await creditContract.connect(borrower2).drawdown(borrower2.address, borrowAmount2);

            creditHash2 = ethers.utils.keccak256(
                ethers.utils.defaultAbiCoder.encode(
                    ["address", "address"],
                    [creditContract.address, borrower2.address],
                ),
            );

            accruedProfit = accruedProfit.add(
                BN.from(nextTime - preTime)
                    .mul(profitRate)
                    .div(CONSTANTS.DEFAULT_DECIMALS_FACTOR),
            );
            let accruedProfit2 = borrowAmount2.mul(frontLoadingFeeBps).div(CONSTANTS.BP_FACTOR);

            let creditRecord2 = await creditContract.creditRecordMap(creditHash2);
            let profitRate2 = calcProfitRateWithCR(creditRecord2, yieldInBps);

            pnlTracker = await creditPnlManagerContract.getPnL();
            // console.log(`pnlTracker: ${pnlTracker}`);
            checkPnLTracker(
                pnlTracker,
                profitRate.add(profitRate2),
                BN.from(0),
                nextTime,
                accruedProfit.add(accruedProfit2),
                BN.from(0),
                BN.from(0),
                2,
            );
            preTime = nextTime;

            // refresh browser credit and its state becomes delayed

            let poolSettings = await poolConfigContract.getPoolSettings();
            let creditRecordSettings = await getCreditRecordSettings();
            let creditConfig = await creditContract.creditConfigMap(creditHash);

            creditRecord = await creditContract.creditRecordMap(creditHash);
            nextTime =
                creditRecord.nextDueDate.toNumber() +
                3600 * 24 * poolSettings.latePaymentGracePeriodInDays +
                60 * 10;
            // printCreditRecord(`creditRecord`, creditRecord);
            // console.log(`nextTime: ${nextTime}`);
            await mineNextBlockWithTimestamp(nextTime);

            let preCreditRecord = creditRecord;
            await creditContract.refreshCredit(borrower.address);
            creditRecord = await creditContract.creditRecordMap(creditHash);

            let [newCreditRecord, ,] = calcLateCreditRecord(
                preCreditRecord,
                creditConfig,
                1,
                nextTime,
                creditRecordSettings,
            );
            // printCreditRecord(`newCreditRecord`, newCreditRecord);
            checkTwoCreditRecords(creditRecord, newCreditRecord);

            profitRate = calcProfitRateWithCR(creditRecord, yieldInBps);
            let [originalLossRate, defaultDate] = calcLossRate(
                preCreditRecord,
                poolSettings.defaultGracePeriodInCalendarUnit,
            );
            let lossRate = originalLossRate.add(profitRate);

            accruedProfit = preCreditRecord.yieldDue
                .add(
                    calcYield(
                        getPrincipal(creditRecord),
                        yieldInBps,
                        nextTime - preCreditRecord.nextDueDate.toNumber(),
                    ),
                )
                .add(borrowAmount.mul(frontLoadingFeeBps).div(CONSTANTS.BP_FACTOR));

            accruedProfit2 = BN.from(
                borrowAmount2.mul(frontLoadingFeeBps).div(CONSTANTS.BP_FACTOR),
            ).add(calcYield(getPrincipal(creditRecord2), yieldInBps, nextTime - preTime));

            let accruedLoss = BN.from(
                originalLossRate
                    .mul(BN.from(nextTime).sub(preCreditRecord.nextDueDate))
                    .div(CONSTANTS.DEFAULT_DECIMALS_FACTOR),
            )
                .add(getPrincipal(creditRecord).sub(getPrincipal(preCreditRecord)))
                .add(
                    calcYield(
                        getPrincipal(creditRecord),
                        yieldInBps,
                        nextTime -
                            getStartDateOfPeriod(
                                CONSTANTS.CALENDAR_UNIT_MONTH,
                                periodDuration,
                                creditRecord.nextDueDate.toNumber(),
                            ),
                    ),
                );

            pnlTracker = await creditPnlManagerContract.getPnL();
            // console.log(`pnlTracker: ${pnlTracker}`);
            checkPnLTracker(
                pnlTracker,
                profitRate.add(profitRate2),
                lossRate,
                nextTime,
                accruedProfit.add(accruedProfit2),
                accruedLoss,
                BN.from(0),
                2,
            );

            let creditLoss = await creditPnlManagerContract.getCreditLoss(creditHash);
            // console.log(`creditLoss: ${creditLoss}`);
            checkCreditLoss(
                creditLoss,
                accruedLoss,
                BN.from(0),
                nextTime,
                defaultDate,
                lossRate,
                1,
            );

            // refresh browser2 credit and its state becomes delayed

            creditRecord2 = await creditContract.creditRecordMap(creditHash2);
            preTime = nextTime;
            nextTime =
                creditRecord2.nextDueDate.toNumber() +
                3600 * 24 * poolSettings.latePaymentGracePeriodInDays +
                60 * 5;
            printCreditRecord(`creditRecord2`, creditRecord2);
            console.log(`nextTime: ${nextTime}`);
            await mineNextBlockWithTimestamp(nextTime);

            let preCreditRecord2 = creditRecord2;
            await creditContract.refreshCredit(borrower2.address);
            creditRecord2 = await creditContract.creditRecordMap(creditHash2);
            printCreditRecord(`creditRecord2`, creditRecord2);

            let [newCreditRecord2, ,] = calcLateCreditRecord(
                preCreditRecord2,
                creditConfig,
                1,
                nextTime,
                creditRecordSettings,
            );
            // printCreditRecord(`newCreditRecord`, newCreditRecord);
            checkTwoCreditRecords(creditRecord2, newCreditRecord2);

            profitRate2 = calcProfitRateWithCR(creditRecord2, yieldInBps);
            let [originalLossRate2, defaultDate2] = calcLossRate(
                preCreditRecord2,
                poolSettings.defaultGracePeriodInCalendarUnit,
            );
            let lossRate2 = originalLossRate2.add(profitRate2);

            accruedProfit2 = BN.from(
                borrowAmount2.mul(frontLoadingFeeBps).div(CONSTANTS.BP_FACTOR),
            )
                .add(getPrincipal(creditRecord2).sub(borrowAmount2))
                .add(
                    calcYield(
                        getPrincipal(creditRecord2),
                        yieldInBps,
                        nextTime - preCreditRecord2.nextDueDate.toNumber(),
                    ),
                );

            accruedProfit = accruedProfit.add(
                calcYield(getPrincipal(creditRecord), yieldInBps, nextTime - preTime),
            );

            let accruedLoss2 = BN.from(
                originalLossRate2
                    .mul(BN.from(nextTime).sub(preCreditRecord2.nextDueDate))
                    .div(CONSTANTS.DEFAULT_DECIMALS_FACTOR),
            )
                .add(getPrincipal(creditRecord2).sub(getPrincipal(preCreditRecord2)))
                .add(
                    calcYield(
                        getPrincipal(creditRecord2),
                        yieldInBps,
                        nextTime -
                            getStartDateOfPeriod(
                                CONSTANTS.CALENDAR_UNIT_MONTH,
                                periodDuration,
                                creditRecord2.nextDueDate.toNumber(),
                            ),
                    ),
                );
            accruedLoss = accruedLoss.add(
                lossRate.mul(nextTime - preTime).div(CONSTANTS.DEFAULT_DECIMALS_FACTOR),
            );
            console.log(
                `profitRate.add(profitRate2): ${profitRate.add(
                    profitRate2,
                )}, lossRate.add(lossRate2): ${lossRate.add(
                    lossRate2,
                )}, accruedProfit.add(accruedProfit2): ${accruedProfit.add(
                    accruedProfit2,
                )}, accruedLoss.add(accruedLoss2): ${accruedLoss.add(accruedLoss2)}`,
            );
            pnlTracker = await creditPnlManagerContract.getPnL();
            console.log(`pnlTracker: ${pnlTracker}`);
            checkPnLTracker(
                pnlTracker,
                profitRate.add(profitRate2),
                lossRate.add(lossRate2),
                nextTime,
                accruedProfit.add(accruedProfit2),
                accruedLoss.add(accruedLoss2),
                BN.from(0),
                2,
            );

            let creditLoss2 = await creditPnlManagerContract.getCreditLoss(creditHash2);
            // console.log(`creditLoss: ${creditLoss}`);
            checkCreditLoss(
                creditLoss2,
                accruedLoss2,
                BN.from(0),
                nextTime,
                defaultDate2,
                lossRate2,
                1,
            );

            // move forward, refresh browser credit and its state becomes defaulted

            preTime = nextTime;
            nextTime =
                getNextMonth(
                    preCreditRecord.nextDueDate.toNumber(),
                    preCreditRecord.nextDueDate.toNumber(),
                    3 * periodDuration,
                )[0] +
                60 * 5;
            await mineNextBlockWithTimestamp(nextTime);

            preCreditRecord = creditRecord;
            await creditContract.refreshCredit(borrower.address);
            creditRecord = await creditContract.creditRecordMap(creditHash);
            printCreditRecord(`creditRecord`, creditRecord);

            [newCreditRecord, ,] = calcLateCreditRecord(
                preCreditRecord,
                creditConfig,
                3,
                nextTime,
                creditRecordSettings,
            );
            newCreditRecord.state = 6;
            checkTwoCreditRecords(creditRecord, newCreditRecord);

            accruedProfit = BN.from(
                borrowAmount.mul(frontLoadingFeeBps).div(CONSTANTS.BP_FACTOR),
            ).add(getPrincipal(creditRecord).sub(borrowAmount));
            accruedProfit2 = accruedProfit2.add(
                profitRate2.mul(nextTime - preTime).div(CONSTANTS.DEFAULT_DECIMALS_FACTOR),
            );

            accruedLoss = getPrincipal(creditRecord);
            accruedLoss2 = accruedLoss2.add(
                lossRate2.mul(nextTime - preTime).div(CONSTANTS.DEFAULT_DECIMALS_FACTOR),
            );
            console.log(
                `profitRate.add(profitRate2): ${profitRate2}, lossRate.add(lossRate2): ${lossRate2}, accruedProfit.add(accruedProfit2): ${accruedProfit.add(
                    accruedProfit2,
                )}, accruedLoss.add(accruedLoss2): ${accruedLoss.add(accruedLoss2)}`,
            );

            pnlTracker = await creditPnlManagerContract.getPnL();
            console.log(`pnlTracker: ${pnlTracker}`);
            checkPnLTracker(
                pnlTracker,
                profitRate2,
                lossRate2,
                nextTime,
                accruedProfit.add(accruedProfit2),
                accruedLoss.add(accruedLoss2),
                BN.from(0),
                4,
            );

            creditLoss = await creditPnlManagerContract.getCreditLoss(creditHash);
            checkCreditLoss(
                creditLoss,
                accruedLoss,
                BN.from(0),
                defaultDate,
                defaultDate,
                BN.from(0),
                3,
            );

            // move forward, refresh browser2 credit and its state becomes defaulted

            preTime = nextTime;
            nextTime =
                getNextMonth(
                    preCreditRecord2.nextDueDate.toNumber(),
                    preCreditRecord2.nextDueDate.toNumber(),
                    3 * periodDuration,
                )[0] +
                60 * 5;
            await mineNextBlockWithTimestamp(nextTime);

            preCreditRecord2 = creditRecord2;
            await creditContract.refreshCredit(borrower2.address);
            creditRecord2 = await creditContract.creditRecordMap(creditHash2);

            [newCreditRecord2, ,] = calcLateCreditRecord(
                preCreditRecord2,
                creditConfig,
                3,
                nextTime,
                creditRecordSettings,
            );
            newCreditRecord2.state = 6;
            checkTwoCreditRecords(creditRecord2, newCreditRecord2);

            accruedProfit2 = BN.from(
                borrowAmount2.mul(frontLoadingFeeBps).div(CONSTANTS.BP_FACTOR),
            ).add(getPrincipal(creditRecord2).sub(borrowAmount2));

            accruedLoss2 = getPrincipal(creditRecord2);

            pnlTracker = await creditPnlManagerContract.getPnL();
            checkPnLTracker(
                pnlTracker,
                BN.from(0),
                BN.from(0),
                nextTime,
                accruedProfit.add(accruedProfit2),
                accruedLoss.add(accruedLoss2),
                BN.from(0),
                5,
            );

            creditLoss2 = await creditPnlManagerContract.getCreditLoss(creditHash2);
            checkCreditLoss(
                creditLoss2,
                accruedLoss2,
                BN.from(0),
                defaultDate2,
                defaultDate2,
                BN.from(0),
                3,
            );
        });
    });

    describe("Delayed Tests", function () {
        it("Should refresh credit and credit becomes Delayed state", async function () {});

        it("Should not borrower in Delayed state", async function () {});

        it("Should make partially payment successfully in Delayed state", async function () {});

        it("Should pay total due successfully and credit becomes GoodStanding state", async function () {});

        it("Should pay off successfully in Delayed state", async function () {});
    });

    describe("Defaulted Tests", function () {
        it("Should refresh credit and credit becomes Defaulted state", async function () {});

        it("Should not borrower in Defaulted state", async function () {});

        it("Should make partially payment successfully in Defaulted state", async function () {});

        it("Should pay off successfully in Defaulted state", async function () {});
    });
});
