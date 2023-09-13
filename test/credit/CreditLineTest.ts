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
} from "../BaseTest";
import {
    getNextTime,
    getNextMonth,
    getNextDate,
    mineNextBlockWithTimestamp,
    toToken,
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
    PlatformFeeManager,
    Pool,
    PoolConfig,
    PoolVault,
    RiskAdjustedTranchesPolicy,
    TrancheVault,
} from "../../typechain-types";
import { CreditRecordStructOutput } from "../../typechain-types/contracts/credit/utils/interfaces/ICreditFeeManager";
import { CreditConfigStructOutput } from "../../typechain-types/contracts/credit/BaseCredit";

let defaultDeployer: SignerWithAddress,
    protocolOwner: SignerWithAddress,
    treasury: SignerWithAddress,
    eaServiceAccount: SignerWithAddress,
    pdsServiceAccount: SignerWithAddress;
let poolOwner: SignerWithAddress,
    poolOwnerTreasury: SignerWithAddress,
    evaluationAgent: SignerWithAddress,
    poolOperator: SignerWithAddress;
let lender: SignerWithAddress, borrower: SignerWithAddress;

let eaNFTContract: EvaluationAgentNFT,
    humaConfigContract: HumaConfig,
    mockTokenContract: MockToken;
let poolConfigContract: PoolConfig,
    platformFeeManagerContract: PlatformFeeManager,
    poolVaultContract: PoolVault,
    calendarContract: Calendar,
    poolOwnerAndEAFirstLossCoverContract: FirstLossCover,
    tranchesPolicyContract: RiskAdjustedTranchesPolicy,
    poolContract: Pool,
    epochManagerContract: EpochManager,
    seniorTrancheVaultContract: TrancheVault,
    juniorTrancheVaultContract: TrancheVault,
    creditContract: CreditLine,
    creditFeeManagerContract: BaseCreditFeeManager,
    creditPnlManagerContract: BasePnLManager;

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
    configs: BN[],
): CreditRecordStructOutput {
    let ncr = { ...cr };
    for (let i = 0; i < periodCount; i++) {
        let [nextDueDate] = getNextMonth(
            ncr.nextDueDate.toNumber(),
            ncr.nextDueDate.toNumber(),
            cc.periodDuration,
        );
        let seconds = nextDueDate - ncr.nextDueDate.toNumber();

        if (cr.totalDue.gt(BN.from(0))) {
            ncr.unbilledPrincipal = ncr.unbilledPrincipal.add(ncr.totalDue);
            ncr.feesDue = calcLateFee(configs, ncr.unbilledPrincipal);
        }

        ncr.yieldDue = calcYield(ncr.unbilledPrincipal, cc.yieldInBps, seconds);

        ncr.feesDue = ncr.feesDue.add(configs[2]);

        let principalToBill = ncr.unbilledPrincipal.mul(configs[3]).div(CONSTANTS.BP_FACTOR);
        ncr.totalDue = ncr.yieldDue.add(ncr.feesDue).add(principalToBill);
        ncr.unbilledPrincipal = ncr.unbilledPrincipal.sub(principalToBill);

        ncr.nextDueDate = BN.from(nextDueDate);
    }
    ncr.remainingPeriods = ncr.remainingPeriods - periodCount;
    ncr.missedPeriods = ncr.missedPeriods + periodCount;
    ncr.state = 5;

    return ncr;
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
            platformFeeManagerContract,
            poolVaultContract,
            calendarContract,
            poolOwnerAndEAFirstLossCoverContract,
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
            [lender, borrower],
        );
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
            let pvBeforeBalance = await mockTokenContract.balanceOf(poolVaultContract.address);
            await expect(creditContract.connect(borrower).drawdown(borrower.address, borrowAmount))
                .to.emit(creditContract, "DrawdownMade")
                .withArgs(borrower.address, borrowAmount, netBorrowAmount)
                .to.emit(creditContract, "BillRefreshed")
                .withArgs(creditHash, nextDueDate, yieldDue);
            let userAfterBalance = await mockTokenContract.balanceOf(borrower.address);
            let pvAfterBalance = await mockTokenContract.balanceOf(poolVaultContract.address);
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
            pvBeforeBalance = await mockTokenContract.balanceOf(poolVaultContract.address);
            await expect(creditContract.connect(borrower).drawdown(borrower.address, borrowAmount))
                .to.emit(creditContract, "DrawdownMade")
                .withArgs(borrower.address, borrowAmount, netBorrowAmount);
            // .to.emit(creditContract, "BillRefreshed");
            // .withArgs(creditHash, nextDueDate, yieldDue);
            userAfterBalance = await mockTokenContract.balanceOf(borrower.address);
            pvAfterBalance = await mockTokenContract.balanceOf(poolVaultContract.address);
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
        async function prepareForMakePayment() {
            let frontLoadingFeeBps = BN.from(100);
            await poolConfigContract.connect(poolOwner).setFrontLoadingFees({
                frontLoadingFeeFlat: 0,
                frontLoadingFeeBps: frontLoadingFeeBps,
            });

            await poolConfigContract
                .connect(poolOwner)
                .setPoolPayPeriod(CONSTANTS.CALENDAR_UNIT_MONTH, 2);

            let juniorDepositAmount = toToken(300_000);
            await juniorTrancheVaultContract
                .connect(lender)
                .deposit(juniorDepositAmount, lender.address);
            let seniorDepositAmount = toToken(100_000);
            await seniorTrancheVaultContract
                .connect(lender)
                .deposit(seniorDepositAmount, lender.address);

            // const yieldInBps = 1217;
            // await creditContract
            //     .connect(eaServiceAccount)
            //     .approveBorrower(
            //         borrower.address,
            //         toToken(100_000),
            //         3,
            //         yieldInBps,
            //         toToken(100_000),
            //         true,
            //     );
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

        it("Should make partially payment successfully in GoodStanding state", async function () {});

        it("Should pay off successfully in GoodStanding state", async function () {});
    });

    describe("RefreshCredit Tests", function () {
        const yieldInBps = 1217;
        const frontLoadingFeeBps = 100;
        let borrowAmount: BN, creditHash: string;

        async function prepareForRefreshCredit() {
            await poolConfigContract.connect(poolOwner).setFrontLoadingFees({
                frontLoadingFeeFlat: 0,
                frontLoadingFeeBps: frontLoadingFeeBps,
            });

            await poolConfigContract
                .connect(poolOwner)
                .setPoolPayPeriod(CONSTANTS.CALENDAR_UNIT_MONTH, 2);

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
            let newCreditRecord = calcLateCreditRecord(
                preCreditRecord,
                creditConfig,
                1,
                creditRecordSettings,
            );
            printCreditRecord(`newCreditRecord`, newCreditRecord);
            checkTwoCreditRecords(creditRecord, newCreditRecord);

            let pnlTracker = await creditPnlManagerContract.getPnL();
            // console.log(`pnlTracker: ${pnlTracker}`);

            let accruedProfit = preCreditRecord.yieldDue
                .add(
                    calcYield(
                        getPrincipal(creditRecord),
                        yieldInBps,
                        nextTime - preCreditRecord.nextDueDate.toNumber(),
                    ),
                )
                .add(borrowAmount.mul(frontLoadingFeeBps).div(CONSTANTS.BP_FACTOR));
            // console.log(
            //     `nextTime: ${nextTime}, getPrincipal(creditRecord): ${getPrincipal(
            //         creditRecord,
            //     )}, nextTime - preCreditRecord.nextDueDate.toNumber(): ${
            //         nextTime - preCreditRecord.nextDueDate.toNumber()
            //     }, calcYield: ${calcYield(
            //         getPrincipal(creditRecord),
            //         yieldInBps,
            //         nextTime - preCreditRecord.nextDueDate.toNumber(),
            //     )}`,
            // );
            // console.log(`accruedProfit: ${accruedProfit}`);
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
