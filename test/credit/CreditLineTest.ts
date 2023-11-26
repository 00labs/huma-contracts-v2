import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { BigNumber as BN } from "ethers";
import { ethers } from "hardhat";
import moment from "moment";
import {
    Calendar,
    CreditDueManager,
    CreditLine,
    EpochManager,
    EvaluationAgentNFT,
    FirstLossCover,
    HumaConfig,
    MockToken,
    Pool,
    PoolConfig,
    PoolFeeManager,
    PoolSafe,
    RiskAdjustedTranchesPolicy,
    TrancheVault,
} from "../../typechain-types";
import {
    CreditRecordStruct,
    DueDetailStruct,
} from "../../typechain-types/contracts/credit/Credit";
import {
    CONSTANTS,
    CreditState,
    calcLateFeeNew,
    calcPrincipalDueNew,
    calcYieldDue,
    calcYieldDueNew,
    checkCreditConfig,
    checkCreditRecord,
    checkCreditRecordsMatch,
    checkDueDetailsMatch,
    deployAndSetupPoolContracts,
    deployProtocolContracts,
    genDueDetail,
    getLatePaymentGracePeriodDeadline,
    getNextBillRefreshDate,
    getNextDueDate,
} from "../BaseTest";
import {
    borrowerLevelCreditHash,
    getDate,
    getDateAfterMonths,
    getFutureBlockTime,
    getLatestBlock,
    getMinFirstLossCoverRequirement,
    getStartOfDay,
    minBigNumber,
    setNextBlockTimestamp,
    toToken,
} from "../TestUtils";

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
    borrowerFirstLossCoverContract: FirstLossCover,
    affiliateFirstLossCoverContract: FirstLossCover,
    tranchesPolicyContract: RiskAdjustedTranchesPolicy,
    poolContract: Pool,
    epochManagerContract: EpochManager,
    seniorTrancheVaultContract: TrancheVault,
    juniorTrancheVaultContract: TrancheVault,
    creditContract: CreditLine,
    creditDueManagerContract: CreditDueManager;

async function getCreditRecordSettings(): Promise<BN[]> {
    let settings = Array<BN>();
    let fees = await poolConfigContract.getFees();
    settings.push(fees[0]);
    settings.push(fees[1]);
    settings.push(fees[2]);
    settings.push(await poolConfigContract.getMinPrincipalRateInBps());
    return settings;
}

function calcPrincipalDueForFullPeriods(
    unbilledPrincipal: BN,
    principalRateInBps: number,
    numPeriods: number,
): BN {
    return CONSTANTS.BP_FACTOR.pow(numPeriods)
        .sub(CONSTANTS.BP_FACTOR.sub(principalRateInBps).pow(numPeriods))
        .mul(unbilledPrincipal)
        .div(CONSTANTS.BP_FACTOR.pow(numPeriods));
}

function calcPrincipalDueForPartialPeriod(
    unbilledPrincipal: BN,
    principalRateInBps: number,
    daysLeft: number | BN,
    totalDaysInFullPeriod: number | BN,
) {
    return unbilledPrincipal
        .mul(principalRateInBps)
        .mul(daysLeft)
        .div(CONSTANTS.BP_FACTOR.mul(totalDaysInFullPeriod));
}

function calcYield(principal: BN, yieldInBps: number, days: number): BN {
    return principal
        .mul(yieldInBps)
        .mul(days)
        .div(CONSTANTS.BP_FACTOR.mul(CONSTANTS.DAYS_IN_A_YEAR));
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
            borrowerFirstLossCoverContract,
            affiliateFirstLossCoverContract,
            tranchesPolicyContract,
            poolContract,
            epochManagerContract,
            seniorTrancheVaultContract,
            juniorTrancheVaultContract,
            creditContract as unknown,
            creditDueManagerContract,
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

        await borrowerFirstLossCoverContract
            .connect(poolOwner)
            .setCoverProvider(borrower.address, {
                poolCapCoverageInBps: 1,
                poolValueCoverageInBps: 100,
            });
        await mockTokenContract
            .connect(borrower)
            .approve(borrowerFirstLossCoverContract.address, ethers.constants.MaxUint256);
        await borrowerFirstLossCoverContract
            .connect(borrower)
            .depositCover(
                (
                    await getMinFirstLossCoverRequirement(
                        borrowerFirstLossCoverContract,
                        poolConfigContract,
                        poolContract,
                        borrower.address,
                    )
                ).mul(2),
            );

        await borrowerFirstLossCoverContract
            .connect(poolOwner)
            .setCoverProvider(borrower2.address, {
                poolCapCoverageInBps: 1,
                poolValueCoverageInBps: 100,
            });
        await mockTokenContract
            .connect(borrower2)
            .approve(borrowerFirstLossCoverContract.address, ethers.constants.MaxUint256);
        await borrowerFirstLossCoverContract
            .connect(borrower2)
            .depositCover(
                (
                    await getMinFirstLossCoverRequirement(
                        borrowerFirstLossCoverContract,
                        poolConfigContract,
                        poolContract,
                        borrower2.address,
                    )
                ).mul(2),
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
            ).to.be.revertedWithCustomError(
                creditContract,
                "committedAmountGreaterThanCreditLimit",
            );

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
            await creditContract.connect(borrower).drawdown(borrower.address, toToken(10_000));
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
                    poolSettings.payPeriodDuration,
                    1,
                    1217,
                    true,
                    poolSettings.advanceRateInBps,
                    false,
                )
                .to.emit(creditContract, "CreditLineApproved")
                .withArgs(
                    borrower.address,
                    creditHash,
                    toToken(10_000),
                    poolSettings.payPeriodDuration,
                    1,
                    1217,
                    toToken(10_000),
                    true,
                );

            let creditConfig = await creditContract.getCreditConfig(creditHash);
            checkCreditConfig(
                creditConfig,
                toToken(10_000),
                toToken(10_000),
                poolSettings.payPeriodDuration,
                1,
                1217,
                true,
                poolSettings.advanceRateInBps,
                false,
            );

            let creditRecord = await creditContract.getCreditRecord(creditHash);
            checkCreditRecord(
                creditRecord,
                BN.from(0),
                0,
                BN.from(0),
                BN.from(0),
                BN.from(0),
                0,
                1,
                2,
            );
            expect(await creditContract.creditBorrowerMap(creditHash)).to.equal(borrower.address);
        });

        it("Should approve again after a credit is closed", async function () {
            await creditContract
                .connect(eaServiceAccount)
                .approveBorrower(borrower.address, toToken(10_000), 1, 1217, toToken(0), true);

            await creditContract.connect(borrower).closeCredit(borrower.address);

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
                        toToken(20_000),
                        3,
                        1217,
                        toToken(20_000),
                        true,
                    ),
            )
                .to.emit(creditContract, "CreditConfigChanged")
                .withArgs(
                    creditHash,
                    toToken(20_000),
                    toToken(20_000),
                    poolSettings.payPeriodDuration,
                    3,
                    1217,
                    true,
                    poolSettings.advanceRateInBps,
                    false,
                )
                .to.emit(creditContract, "CreditLineApproved")
                .withArgs(
                    borrower.address,
                    creditHash,
                    toToken(20_000),
                    poolSettings.payPeriodDuration,
                    3,
                    1217,
                    toToken(20_000),
                    true,
                );

            let creditConfig = await creditContract.getCreditConfig(creditHash);
            checkCreditConfig(
                creditConfig,
                toToken(20_000),
                toToken(20_000),
                poolSettings.payPeriodDuration,
                3,
                1217,
                true,
                poolSettings.advanceRateInBps,
                false,
            );

            let creditRecord = await creditContract.getCreditRecord(creditHash);
            checkCreditRecord(
                creditRecord,
                BN.from(0),
                0,
                BN.from(0),
                BN.from(0),
                BN.from(0),
                0,
                3,
                2,
            );
            expect(await creditContract.creditBorrowerMap(creditHash)).to.equal(borrower.address);
        });

        it("Should approve with creditApprovalExpirationInDays setting", async function () {
            const expirationInDays = 1;
            await poolConfigContract
                .connect(poolOwner)
                .setCreditApprovalExpiration(expirationInDays);

            let block = await getLatestBlock();
            let nextTime = block.timestamp + 100;
            let expiredDate =
                getStartOfDay(nextTime) + expirationInDays * CONSTANTS.SECONDS_IN_A_DAY;
            await setNextBlockTimestamp(nextTime);

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
                        3,
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
                    poolSettings.payPeriodDuration,
                    3,
                    1217,
                    true,
                    poolSettings.advanceRateInBps,
                    false,
                )
                .to.emit(creditContract, "CreditLineApproved")
                .withArgs(
                    borrower.address,
                    creditHash,
                    toToken(10_000),
                    poolSettings.payPeriodDuration,
                    3,
                    1217,
                    toToken(10_000),
                    true,
                );

            let creditConfig = await creditContract.getCreditConfig(creditHash);
            checkCreditConfig(
                creditConfig,
                toToken(10_000),
                toToken(10_000),
                poolSettings.payPeriodDuration,
                3,
                1217,
                true,
                poolSettings.advanceRateInBps,
                false,
            );

            let creditRecord = await creditContract.getCreditRecord(creditHash);
            checkCreditRecord(
                creditRecord,
                BN.from(0),
                expiredDate,
                BN.from(0),
                BN.from(0),
                BN.from(0),
                0,
                3,
                2,
            );
            expect(await creditContract.creditBorrowerMap(creditHash)).to.equal(borrower.address);
        });
    });

    describe("Drawdown Tests", function () {
        let yieldInBps = 1217;
        let numOfPeriods = 5;

        describe("Without committment", function () {
            async function prepareForDrawdown() {
                await creditContract
                    .connect(eaServiceAccount)
                    .approveBorrower(
                        borrower.address,
                        toToken(100_000),
                        numOfPeriods,
                        yieldInBps,
                        toToken(0),
                        true,
                    );
            }

            beforeEach(async function () {
                await loadFixture(prepareForDrawdown);
            });

            it("Should not approve while protocol is paused or pool is not on", async function () {
                await humaConfigContract.connect(protocolOwner).pause();
                await expect(
                    creditContract.connect(borrower).drawdown(borrower.address, toToken(10_000)),
                ).to.be.revertedWithCustomError(poolConfigContract, "protocolIsPaused");
                await humaConfigContract.connect(protocolOwner).unpause();

                await poolContract.connect(poolOwner).disablePool();
                await expect(
                    creditContract.connect(borrower).drawdown(borrower.address, toToken(10_000)),
                ).to.be.revertedWithCustomError(poolConfigContract, "poolIsNotOn");
            });

            it("Should not allow drawdown with invalid parameters", async function () {
                await expect(
                    creditContract.connect(borrower).drawdown(borrower2.address, toToken(10_000)),
                ).to.be.revertedWithCustomError(creditContract, "notBorrower");

                await expect(
                    creditContract.connect(borrower2).drawdown(borrower2.address, toToken(10_000)),
                ).to.be.revertedWithCustomError(creditContract, "notBorrower");

                await expect(
                    creditContract.connect(borrower).drawdown(borrower.address, toToken(0)),
                ).to.be.revertedWithCustomError(creditContract, "zeroAmountProvided");

                await expect(
                    creditContract.connect(borrower).drawdown(borrower.address, toToken(100_001)),
                ).to.be.revertedWithCustomError(creditContract, "creditLineExceeded");
            });

            it("Should not allow drawdown if the credit line is in wrong state", async function () {
                await creditContract.connect(borrower).closeCredit(borrower.address);

                await expect(
                    creditContract.connect(borrower).drawdown(borrower.address, toToken(10_000)),
                ).to.be.revertedWithCustomError(creditContract, "creditNotInStateForDrawdown");
            });

            // TODO is this test valid?
            it.skip("Should not allow drawdown during late grace period", async function () {});

            it("Should not allow drawdown while credit state is Delayed", async function () {
                await creditContract.connect(borrower).drawdown(borrower.address, toToken(10_000));
                const creditHash = ethers.utils.keccak256(
                    ethers.utils.defaultAbiCoder.encode(
                        ["address", "address"],
                        [creditContract.address, borrower.address],
                    ),
                );
                let creditRecord = await creditContract.getCreditRecord(creditHash);
                let settings = await poolConfigContract.getPoolSettings();
                let nextTime =
                    creditRecord.nextDueDate.toNumber() +
                    settings.latePaymentGracePeriodInDays * CONSTANTS.SECONDS_IN_A_DAY +
                    100;
                await setNextBlockTimestamp(nextTime);

                await expect(
                    creditContract.connect(borrower).drawdown(borrower.address, toToken(10_000)),
                ).to.be.revertedWithCustomError(
                    creditContract,
                    "creditLineNotInGoodStandingState",
                );
            });

            it("Should not allow drawdown while credit state is Defaulted", async function () {});

            it("Should not allow drawdown while borrowers don't meet first loss cover requirement", async function () {
                await borrowerFirstLossCoverContract
                    .connect(poolOwner)
                    .setCoverProvider(borrower.address, {
                        poolCapCoverageInBps: 5,
                        poolValueCoverageInBps: 500,
                    });

                await expect(
                    creditContract.connect(borrower).drawdown(borrower.address, toToken(10_000)),
                ).to.be.revertedWithCustomError(
                    creditContract,
                    "insufficientBorrowerFirstLossCover",
                );
            });

            it("Should not allow drawdown after credit approval expiration", async function () {
                await poolConfigContract.connect(poolOwner).setCreditApprovalExpiration(1);
                await creditContract
                    .connect(eaServiceAccount)
                    .approveBorrower(
                        borrower.address,
                        toToken(100_000),
                        1,
                        1217,
                        toToken(0),
                        true,
                    );
                const creditHash = ethers.utils.keccak256(
                    ethers.utils.defaultAbiCoder.encode(
                        ["address", "address"],
                        [creditContract.address, borrower.address],
                    ),
                );
                let cr = await creditContract.getCreditRecord(creditHash);
                await setNextBlockTimestamp(cr.nextDueDate.toNumber() + 100);

                await expect(
                    creditContract.connect(borrower).drawdown(borrower.address, toToken(10_000)),
                ).to.be.revertedWithCustomError(
                    creditContract,
                    "creditExpiredDueToFirstDrawdownTooLate",
                );
            });

            it("Should not allow drawdown again if the credit line is non-revolving", async function () {
                await creditContract
                    .connect(eaServiceAccount)
                    .approveBorrower(
                        borrower.address,
                        toToken(100_000),
                        1,
                        1217,
                        toToken(0),
                        false,
                    );
                await creditContract.connect(borrower).drawdown(borrower.address, toToken(10_000));

                await expect(
                    creditContract.connect(borrower).drawdown(borrower.address, toToken(10_000)),
                ).to.be.revertedWithCustomError(
                    creditContract,
                    "attemptedDrawdownForNonrevolvingLine",
                );
            });

            it("Should not allow drawdown again while credit limit is exceeded after updateDueInfo", async function () {
                await creditContract
                    .connect(eaServiceAccount)
                    .approveBorrower(borrower.address, toToken(10_000), 5, 1217, toToken(0), true);
                await creditContract.connect(borrower).drawdown(borrower.address, toToken(9_000));

                await expect(
                    creditContract.connect(borrower).drawdown(borrower.address, toToken(1_001)),
                ).to.be.revertedWithCustomError(creditContract, "creditLineExceeded");
            });

            it("Should not allow drawdown if the borrow amount is less than front loading fees after updateDueInfo", async function () {
                const frontLoadingFeeFlat = toToken(1000);
                const frontLoadingFeeBps = BN.from(0);
                await poolConfigContract.connect(poolOwner).setFrontLoadingFees({
                    frontLoadingFeeFlat: frontLoadingFeeFlat,
                    frontLoadingFeeBps: frontLoadingFeeBps,
                });

                await expect(
                    creditContract.connect(borrower).drawdown(borrower.address, toToken(999)),
                ).to.be.revertedWithCustomError(
                    creditDueManagerContract,
                    "borrowingAmountLessThanPlatformFees",
                );
            });

            it("Should allow the borrower to borrow for the first time", async function () {
                const frontLoadingFeeFlat = toToken(100);
                const frontLoadingFeeBps = BN.from(100);
                await poolConfigContract.connect(poolOwner).setFrontLoadingFees({
                    frontLoadingFeeFlat: frontLoadingFeeFlat,
                    frontLoadingFeeBps: frontLoadingFeeBps,
                });

                const creditHash = ethers.utils.keccak256(
                    ethers.utils.defaultAbiCoder.encode(
                        ["address", "address"],
                        [creditContract.address, borrower.address],
                    ),
                );

                const borrowAmount = toToken(50_000);
                const netBorrowAmount = borrowAmount
                    .mul(CONSTANTS.BP_FACTOR.sub(frontLoadingFeeBps))
                    .div(CONSTANTS.BP_FACTOR)
                    .sub(frontLoadingFeeFlat);
                let nextTime = await getFutureBlockTime(3);
                await setNextBlockTimestamp(nextTime);

                let startOfDay = getStartOfDay(nextTime);
                let nextDueDate = await calendarContract.getStartDateOfNextPeriod(
                    CONSTANTS.PERIOD_DURATION_MONTHLY,
                    nextTime,
                );
                let days = (
                    await calendarContract.getDaysDiff(startOfDay, nextDueDate)
                ).toNumber();
                let cc = await creditContract.getCreditConfig(creditHash);
                const [yieldDue] = calcYieldDue(cc, borrowAmount, days, 1, BN.from(0));

                const borrowerOldBalance = await mockTokenContract.balanceOf(borrower.address);
                const poolSafeOldBalance = await mockTokenContract.balanceOf(
                    poolSafeContract.address,
                );
                await expect(
                    creditContract.connect(borrower).drawdown(borrower.address, borrowAmount),
                )
                    .to.emit(creditContract, "DrawdownMade")
                    .withArgs(borrower.address, borrowAmount, netBorrowAmount)
                    .to.emit(creditContract, "BillRefreshed")
                    .withArgs(creditHash, nextDueDate, yieldDue);
                const borrowerNewBalance = await mockTokenContract.balanceOf(borrower.address);
                const poolSafeNewBalance = await mockTokenContract.balanceOf(
                    poolSafeContract.address,
                );
                expect(borrowerNewBalance.sub(borrowerOldBalance)).to.equal(netBorrowAmount);
                expect(poolSafeOldBalance.sub(poolSafeNewBalance)).to.equal(netBorrowAmount);

                const creditRecord = await creditContract.getCreditRecord(creditHash);
                checkCreditRecord(
                    creditRecord,
                    borrowAmount,
                    nextDueDate,
                    yieldDue,
                    yieldDue,
                    BN.from(0),
                    0,
                    getDate(nextTime) == 1 ? numOfPeriods - 1 : numOfPeriods,
                    3,
                );

                const dueDetail = await creditContract.getDueDetail(creditHash);
                checkDueDetailsMatch(dueDetail, genDueDetail({ accrued: yieldDue }));

                expect(await creditContract.maturityDates(creditHash)).to.equal(
                    getDateAfterMonths(startOfDay, numOfPeriods),
                );
            });

            it("Should allow the borrower to borrow again in the same period", async function () {
                const frontLoadingFeeFlat = toToken(100);
                const frontLoadingFeeBps = BN.from(100);
                await poolConfigContract.connect(poolOwner).setFrontLoadingFees({
                    frontLoadingFeeFlat: frontLoadingFeeFlat,
                    frontLoadingFeeBps: frontLoadingFeeBps,
                });

                const creditHash = ethers.utils.keccak256(
                    ethers.utils.defaultAbiCoder.encode(
                        ["address", "address"],
                        [creditContract.address, borrower.address],
                    ),
                );

                let borrowAmount = toToken(30_000);
                let totalBorrowAmount = borrowAmount;
                let netBorrowAmount = borrowAmount
                    .mul(CONSTANTS.BP_FACTOR.sub(frontLoadingFeeBps))
                    .div(CONSTANTS.BP_FACTOR)
                    .sub(frontLoadingFeeFlat);
                let nextTime = await getFutureBlockTime(3);
                await setNextBlockTimestamp(nextTime);

                let startOfDay = getStartOfDay(nextTime);
                let nextDueDate = await calendarContract.getStartDateOfNextPeriod(
                    CONSTANTS.PERIOD_DURATION_MONTHLY,
                    nextTime,
                );
                let days = (
                    await calendarContract.getDaysDiff(startOfDay, nextDueDate)
                ).toNumber();
                let cc = await creditContract.getCreditConfig(creditHash);
                let [yieldDue] = calcYieldDue(cc, borrowAmount, days, 1, BN.from(0));
                let totalYieldDue = yieldDue;

                let borrowerOldBalance = await mockTokenContract.balanceOf(borrower.address);
                let poolSafeOldBalance = await mockTokenContract.balanceOf(
                    poolSafeContract.address,
                );
                await expect(
                    creditContract.connect(borrower).drawdown(borrower.address, borrowAmount),
                )
                    .to.emit(creditContract, "DrawdownMade")
                    .withArgs(borrower.address, borrowAmount, netBorrowAmount)
                    .to.emit(creditContract, "BillRefreshed")
                    .withArgs(creditHash, nextDueDate, yieldDue);
                let borrowerNewBalance = await mockTokenContract.balanceOf(borrower.address);
                let poolSafeNewBalance = await mockTokenContract.balanceOf(
                    poolSafeContract.address,
                );
                expect(borrowerNewBalance.sub(borrowerOldBalance)).to.equal(netBorrowAmount);
                expect(poolSafeOldBalance.sub(poolSafeNewBalance)).to.equal(netBorrowAmount);

                let creditRecord = await creditContract.getCreditRecord(creditHash);
                checkCreditRecord(
                    creditRecord,
                    borrowAmount,
                    nextDueDate,
                    yieldDue,
                    yieldDue,
                    BN.from(0),
                    0,
                    getDate(nextTime) == 1 ? numOfPeriods - 1 : numOfPeriods,
                    3,
                );
                const remainingPeriods = creditRecord.remainingPeriods;
                let dueDetail = await creditContract.getDueDetail(creditHash);
                checkDueDetailsMatch(dueDetail, genDueDetail({ accrued: yieldDue }));
                let maturityDate = await creditContract.maturityDates(creditHash);
                expect(maturityDate).to.equal(getDateAfterMonths(startOfDay, numOfPeriods));

                // move forward to the middle of the remaining time of the period
                nextTime = nextTime + Math.floor((nextDueDate.toNumber() - nextTime) / 2);
                await setNextBlockTimestamp(nextTime);

                borrowAmount = toToken(10_000);
                totalBorrowAmount = totalBorrowAmount.add(borrowAmount);
                netBorrowAmount = borrowAmount
                    .mul(CONSTANTS.BP_FACTOR.sub(frontLoadingFeeBps))
                    .div(CONSTANTS.BP_FACTOR)
                    .sub(frontLoadingFeeFlat);

                startOfDay = getStartOfDay(nextTime);
                days = (await calendarContract.getDaysDiff(startOfDay, nextDueDate)).toNumber();
                [yieldDue] = calcYieldDue(cc, borrowAmount, days, 1, BN.from(0));
                totalYieldDue = totalYieldDue.add(yieldDue);

                borrowerOldBalance = await mockTokenContract.balanceOf(borrower.address);
                poolSafeOldBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
                await expect(
                    creditContract.connect(borrower).drawdown(borrower.address, borrowAmount),
                )
                    .to.emit(creditContract, "DrawdownMade")
                    .withArgs(borrower.address, borrowAmount, netBorrowAmount);
                borrowerNewBalance = await mockTokenContract.balanceOf(borrower.address);
                poolSafeNewBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
                expect(borrowerNewBalance.sub(borrowerOldBalance)).to.equal(netBorrowAmount);
                expect(poolSafeOldBalance.sub(poolSafeNewBalance)).to.equal(netBorrowAmount);

                creditRecord = await creditContract.getCreditRecord(creditHash);
                checkCreditRecord(
                    creditRecord,
                    totalBorrowAmount,
                    nextDueDate,
                    totalYieldDue,
                    totalYieldDue,
                    BN.from(0),
                    0,
                    remainingPeriods,
                    3,
                );
                dueDetail = await creditContract.getDueDetail(creditHash);
                checkDueDetailsMatch(dueDetail, genDueDetail({ accrued: totalYieldDue }));
                expect(await creditContract.maturityDates(creditHash)).to.equal(maturityDate);
            });

            it("Should allow the borrower to borrow again in the next period", async function () {
                const creditHash = ethers.utils.keccak256(
                    ethers.utils.defaultAbiCoder.encode(
                        ["address", "address"],
                        [creditContract.address, borrower.address],
                    ),
                );

                let borrowAmount = toToken(25000);
                let totalBorrowAmount = borrowAmount;
                await creditContract.connect(borrower).drawdown(borrower.address, borrowAmount);

                let creditRecord = await creditContract.getCreditRecord(creditHash);
                await creditContract
                    .connect(borrower)
                    .makePayment(borrower.address, creditRecord.nextDue);

                const nextTime =
                    creditRecord.nextDueDate.toNumber() + CONSTANTS.SECONDS_IN_A_DAY * 10;
                await setNextBlockTimestamp(nextTime);

                const frontLoadingFeeFlat = toToken(200);
                const frontLoadingFeeBps = BN.from(200);
                await poolConfigContract.connect(poolOwner).setFrontLoadingFees({
                    frontLoadingFeeFlat: frontLoadingFeeFlat,
                    frontLoadingFeeBps: frontLoadingFeeBps,
                });

                let cc = await creditContract.getCreditConfig(creditHash);
                let [yieldDue] = calcYieldDue(cc, borrowAmount, 30, 1, BN.from(0));
                let totalYieldDue = yieldDue;
                borrowAmount = toToken(35000);
                totalBorrowAmount = totalBorrowAmount.add(borrowAmount);
                const netBorrowAmount = borrowAmount
                    .mul(CONSTANTS.BP_FACTOR.sub(frontLoadingFeeBps))
                    .div(CONSTANTS.BP_FACTOR)
                    .sub(frontLoadingFeeFlat);

                let startOfDay = getStartOfDay(nextTime);
                let nextDueDate = await calendarContract.getStartDateOfNextPeriod(
                    CONSTANTS.PERIOD_DURATION_MONTHLY,
                    nextTime,
                );
                let days = (
                    await calendarContract.getDaysDiff(startOfDay, nextDueDate)
                ).toNumber();
                [yieldDue] = calcYieldDue(cc, borrowAmount, days, 1, BN.from(0));

                const maturityDate = await creditContract.maturityDates(creditHash);
                const remainingPeriods = creditRecord.remainingPeriods;
                const borrowerOldBalance = await mockTokenContract.balanceOf(borrower.address);
                const poolSafeOldBalance = await mockTokenContract.balanceOf(
                    poolSafeContract.address,
                );
                await expect(
                    creditContract.connect(borrower).drawdown(borrower.address, borrowAmount),
                )
                    .to.emit(creditContract, "DrawdownMade")
                    .withArgs(borrower.address, borrowAmount, netBorrowAmount)
                    .to.emit(creditContract, "BillRefreshed")
                    .withArgs(creditHash, nextDueDate, totalYieldDue);
                const borrowerNewBalance = await mockTokenContract.balanceOf(borrower.address);
                const poolSafeNewBalance = await mockTokenContract.balanceOf(
                    poolSafeContract.address,
                );
                expect(borrowerNewBalance.sub(borrowerOldBalance)).to.equal(netBorrowAmount);
                expect(poolSafeOldBalance.sub(poolSafeNewBalance)).to.equal(netBorrowAmount);

                totalYieldDue = totalYieldDue.add(yieldDue);

                creditRecord = await creditContract.getCreditRecord(creditHash);
                checkCreditRecord(
                    creditRecord,
                    totalBorrowAmount,
                    nextDueDate,
                    totalYieldDue,
                    totalYieldDue,
                    BN.from(0),
                    0,
                    remainingPeriods - 1,
                    3,
                );

                const dueDetail = await creditContract.getDueDetail(creditHash);
                checkDueDetailsMatch(dueDetail, genDueDetail({ accrued: totalYieldDue }));

                expect(await creditContract.maturityDates(creditHash)).to.equal(maturityDate);
            });
        });

        describe("With commitment", function () {
            async function prepareForDrawdown() {
                await creditContract
                    .connect(eaServiceAccount)
                    .approveBorrower(
                        borrower.address,
                        toToken(100_000),
                        numOfPeriods,
                        yieldInBps,
                        toToken(20_000),
                        true,
                    );
            }

            beforeEach(async function () {
                await loadFixture(prepareForDrawdown);
            });

            it("Should allow the borrower to borrow if the committed yield is less than the accrued yield", async function () {
                const creditHash = ethers.utils.keccak256(
                    ethers.utils.defaultAbiCoder.encode(
                        ["address", "address"],
                        [creditContract.address, borrower.address],
                    ),
                );

                const borrowAmount = toToken(30_000);
                const netBorrowAmount = borrowAmount;
                let nextTime = await getFutureBlockTime(3);
                await setNextBlockTimestamp(nextTime);

                let startOfDay = getStartOfDay(nextTime);
                let nextDueDate = await calendarContract.getStartDateOfNextPeriod(
                    CONSTANTS.PERIOD_DURATION_MONTHLY,
                    nextTime,
                );
                let days = (
                    await calendarContract.getDaysDiff(startOfDay, nextDueDate)
                ).toNumber();
                let cc = await creditContract.getCreditConfig(creditHash);
                const [yieldDue, committed] = calcYieldDue(cc, borrowAmount, days, 1, BN.from(0));

                const borrowerOldBalance = await mockTokenContract.balanceOf(borrower.address);
                const poolSafeOldBalance = await mockTokenContract.balanceOf(
                    poolSafeContract.address,
                );
                await expect(
                    creditContract.connect(borrower).drawdown(borrower.address, borrowAmount),
                )
                    .to.emit(creditContract, "DrawdownMade")
                    .withArgs(borrower.address, borrowAmount, netBorrowAmount)
                    .to.emit(creditContract, "BillRefreshed")
                    .withArgs(creditHash, nextDueDate, yieldDue);
                const borrowerNewBalance = await mockTokenContract.balanceOf(borrower.address);
                const poolSafeNewBalance = await mockTokenContract.balanceOf(
                    poolSafeContract.address,
                );
                expect(borrowerNewBalance.sub(borrowerOldBalance)).to.equal(netBorrowAmount);
                expect(poolSafeOldBalance.sub(poolSafeNewBalance)).to.equal(netBorrowAmount);

                const creditRecord = await creditContract.getCreditRecord(creditHash);
                checkCreditRecord(
                    creditRecord,
                    borrowAmount,
                    nextDueDate,
                    yieldDue,
                    yieldDue,
                    BN.from(0),
                    0,
                    getDate(nextTime) == 1 ? numOfPeriods - 1 : numOfPeriods,
                    3,
                );

                const dueDetail = await creditContract.getDueDetail(creditHash);
                checkDueDetailsMatch(
                    dueDetail,
                    genDueDetail({ accrued: yieldDue, committed: committed }),
                );

                expect(await creditContract.maturityDates(creditHash)).to.equal(
                    getDateAfterMonths(startOfDay, numOfPeriods),
                );
            });

            it("Should allow the borrower to borrow if the committed yield is greater than the accrued yield", async function () {
                const creditHash = ethers.utils.keccak256(
                    ethers.utils.defaultAbiCoder.encode(
                        ["address", "address"],
                        [creditContract.address, borrower.address],
                    ),
                );

                const borrowAmount = toToken(10_000);
                const netBorrowAmount = borrowAmount;
                let nextTime = await getFutureBlockTime(3);
                await setNextBlockTimestamp(nextTime);

                let startOfDay = getStartOfDay(nextTime);
                let nextDueDate = await calendarContract.getStartDateOfNextPeriod(
                    CONSTANTS.PERIOD_DURATION_MONTHLY,
                    nextTime,
                );
                let days = (
                    await calendarContract.getDaysDiff(startOfDay, nextDueDate)
                ).toNumber();
                let cc = await creditContract.getCreditConfig(creditHash);
                const [yieldDue, committed] = calcYieldDue(cc, borrowAmount, days, 1, BN.from(0));

                const borrowerOldBalance = await mockTokenContract.balanceOf(borrower.address);
                const poolSafeOldBalance = await mockTokenContract.balanceOf(
                    poolSafeContract.address,
                );
                await expect(
                    creditContract.connect(borrower).drawdown(borrower.address, borrowAmount),
                )
                    .to.emit(creditContract, "DrawdownMade")
                    .withArgs(borrower.address, borrowAmount, netBorrowAmount)
                    .to.emit(creditContract, "BillRefreshed")
                    .withArgs(creditHash, nextDueDate, committed);
                const borrowerNewBalance = await mockTokenContract.balanceOf(borrower.address);
                const poolSafeNewBalance = await mockTokenContract.balanceOf(
                    poolSafeContract.address,
                );
                expect(borrowerNewBalance.sub(borrowerOldBalance)).to.equal(netBorrowAmount);
                expect(poolSafeOldBalance.sub(poolSafeNewBalance)).to.equal(netBorrowAmount);

                const creditRecord = await creditContract.getCreditRecord(creditHash);
                checkCreditRecord(
                    creditRecord,
                    borrowAmount,
                    nextDueDate,
                    committed,
                    committed,
                    BN.from(0),
                    0,
                    getDate(nextTime) == 1 ? numOfPeriods - 1 : numOfPeriods,
                    3,
                );

                const dueDetail = await creditContract.getDueDetail(creditHash);
                checkDueDetailsMatch(
                    dueDetail,
                    genDueDetail({ accrued: yieldDue, committed: committed }),
                );

                expect(await creditContract.maturityDates(creditHash)).to.equal(
                    getDateAfterMonths(startOfDay, numOfPeriods),
                );
            });

            it("Should allow the borrower to borrow if the committed yield is greater than the accrued yield first, but becomes less than accrued yield after drawdown", async function () {
                const frontLoadingFeeFlat = toToken(100);
                const frontLoadingFeeBps = BN.from(100);
                await poolConfigContract.connect(poolOwner).setFrontLoadingFees({
                    frontLoadingFeeFlat: frontLoadingFeeFlat,
                    frontLoadingFeeBps: frontLoadingFeeBps,
                });

                const creditHash = ethers.utils.keccak256(
                    ethers.utils.defaultAbiCoder.encode(
                        ["address", "address"],
                        [creditContract.address, borrower.address],
                    ),
                );

                let borrowAmount = toToken(10_000);
                let totalBorrowAmount = borrowAmount;
                let netBorrowAmount = borrowAmount
                    .mul(CONSTANTS.BP_FACTOR.sub(frontLoadingFeeBps))
                    .div(CONSTANTS.BP_FACTOR)
                    .sub(frontLoadingFeeFlat);
                let nextTime = await getFutureBlockTime(3);
                await setNextBlockTimestamp(nextTime);

                let startOfDay = getStartOfDay(nextTime);
                let nextDueDate = await calendarContract.getStartDateOfNextPeriod(
                    CONSTANTS.PERIOD_DURATION_MONTHLY,
                    nextTime,
                );
                let days = (
                    await calendarContract.getDaysDiff(startOfDay, nextDueDate)
                ).toNumber();
                const cc = await creditContract.getCreditConfig(creditHash);
                let [yieldDue, committed] = calcYieldDue(cc, borrowAmount, days, 1, BN.from(0));
                let totalYieldDue = yieldDue;

                await creditContract.connect(borrower).drawdown(borrower.address, borrowAmount);

                let creditRecord = await creditContract.getCreditRecord(creditHash);
                checkCreditRecord(
                    creditRecord,
                    borrowAmount,
                    nextDueDate,
                    committed,
                    committed,
                    BN.from(0),
                    0,
                    getDate(nextTime) == 1 ? numOfPeriods - 1 : numOfPeriods,
                    3,
                );
                const remainingPeriods = creditRecord.remainingPeriods;

                let dueDetail = await creditContract.getDueDetail(creditHash);
                checkDueDetailsMatch(
                    dueDetail,
                    genDueDetail({ accrued: yieldDue, committed: committed }),
                );
                let maturityDate = await creditContract.maturityDates(creditHash);
                expect(maturityDate).to.equal(getDateAfterMonths(startOfDay, numOfPeriods));

                // move forward to the middle of the remaining time of the period
                nextTime = nextTime + Math.floor((nextDueDate.toNumber() - nextTime) / 2);
                await setNextBlockTimestamp(nextTime);

                borrowAmount = toToken(50_000);
                totalBorrowAmount = totalBorrowAmount.add(borrowAmount);
                netBorrowAmount = borrowAmount
                    .mul(CONSTANTS.BP_FACTOR.sub(frontLoadingFeeBps))
                    .div(CONSTANTS.BP_FACTOR)
                    .sub(frontLoadingFeeFlat);

                startOfDay = getStartOfDay(nextTime);
                days = (await calendarContract.getDaysDiff(startOfDay, nextDueDate)).toNumber();
                [yieldDue] = calcYieldDue(cc, borrowAmount, days, 1, BN.from(0));
                totalYieldDue = totalYieldDue.add(yieldDue);

                let borrowerOldBalance = await mockTokenContract.balanceOf(borrower.address);
                let poolSafeOldBalance = await mockTokenContract.balanceOf(
                    poolSafeContract.address,
                );
                await expect(
                    creditContract.connect(borrower).drawdown(borrower.address, borrowAmount),
                )
                    .to.emit(creditContract, "DrawdownMade")
                    .withArgs(borrower.address, borrowAmount, netBorrowAmount);
                let borrowerNewBalance = await mockTokenContract.balanceOf(borrower.address);
                let poolSafeNewBalance = await mockTokenContract.balanceOf(
                    poolSafeContract.address,
                );
                expect(borrowerNewBalance.sub(borrowerOldBalance)).to.equal(netBorrowAmount);
                expect(poolSafeOldBalance.sub(poolSafeNewBalance)).to.equal(netBorrowAmount);

                creditRecord = await creditContract.getCreditRecord(creditHash);
                checkCreditRecord(
                    creditRecord,
                    totalBorrowAmount,
                    nextDueDate,
                    totalYieldDue,
                    totalYieldDue,
                    BN.from(0),
                    0,
                    remainingPeriods,
                    3,
                );
                dueDetail = await creditContract.getDueDetail(creditHash);
                checkDueDetailsMatch(
                    dueDetail,
                    genDueDetail({ accrued: totalYieldDue, committed: committed }),
                );
                expect(await creditContract.maturityDates(creditHash)).to.equal(maturityDate);
            });

            it("Should allow the borrower to borrow twice if the committed yield is greater than the accrued yield", async function () {
                const frontLoadingFeeFlat = toToken(100);
                const frontLoadingFeeBps = BN.from(100);
                await poolConfigContract.connect(poolOwner).setFrontLoadingFees({
                    frontLoadingFeeFlat: frontLoadingFeeFlat,
                    frontLoadingFeeBps: frontLoadingFeeBps,
                });

                const creditHash = ethers.utils.keccak256(
                    ethers.utils.defaultAbiCoder.encode(
                        ["address", "address"],
                        [creditContract.address, borrower.address],
                    ),
                );

                let borrowAmount = toToken(25_000);
                let totalBorrowAmount = borrowAmount;
                let netBorrowAmount = borrowAmount
                    .mul(CONSTANTS.BP_FACTOR.sub(frontLoadingFeeBps))
                    .div(CONSTANTS.BP_FACTOR)
                    .sub(frontLoadingFeeFlat);
                let nextTime = await getFutureBlockTime(3);
                await setNextBlockTimestamp(nextTime);

                let startOfDay = getStartOfDay(nextTime);
                let nextDueDate = await calendarContract.getStartDateOfNextPeriod(
                    CONSTANTS.PERIOD_DURATION_MONTHLY,
                    nextTime,
                );
                let days = (
                    await calendarContract.getDaysDiff(startOfDay, nextDueDate)
                ).toNumber();
                const cc = await creditContract.getCreditConfig(creditHash);
                let [yieldDue, committed] = calcYieldDue(cc, borrowAmount, days, 1, BN.from(0));
                let totalYieldDue = yieldDue;

                await creditContract.connect(borrower).drawdown(borrower.address, borrowAmount);

                let creditRecord = await creditContract.getCreditRecord(creditHash);
                checkCreditRecord(
                    creditRecord,
                    borrowAmount,
                    nextDueDate,
                    totalYieldDue,
                    totalYieldDue,
                    BN.from(0),
                    0,
                    getDate(nextTime) == 1 ? numOfPeriods - 1 : numOfPeriods,
                    3,
                );
                const remainingPeriods = creditRecord.remainingPeriods;

                let dueDetail = await creditContract.getDueDetail(creditHash);
                checkDueDetailsMatch(
                    dueDetail,
                    genDueDetail({ accrued: totalYieldDue, committed: committed }),
                );
                let maturityDate = await creditContract.maturityDates(creditHash);
                expect(maturityDate).to.equal(getDateAfterMonths(startOfDay, numOfPeriods));

                // move forward to the middle of the remaining time of the period
                nextTime = nextTime + Math.floor((nextDueDate.toNumber() - nextTime) / 2);
                await setNextBlockTimestamp(nextTime);

                borrowAmount = toToken(10_000);
                totalBorrowAmount = totalBorrowAmount.add(borrowAmount);
                netBorrowAmount = borrowAmount
                    .mul(CONSTANTS.BP_FACTOR.sub(frontLoadingFeeBps))
                    .div(CONSTANTS.BP_FACTOR)
                    .sub(frontLoadingFeeFlat);

                startOfDay = getStartOfDay(nextTime);
                days = (await calendarContract.getDaysDiff(startOfDay, nextDueDate)).toNumber();
                [yieldDue] = calcYieldDue(cc, borrowAmount, days, 1, BN.from(0));
                totalYieldDue = totalYieldDue.add(yieldDue);

                let borrowerOldBalance = await mockTokenContract.balanceOf(borrower.address);
                let poolSafeOldBalance = await mockTokenContract.balanceOf(
                    poolSafeContract.address,
                );
                await expect(
                    creditContract.connect(borrower).drawdown(borrower.address, borrowAmount),
                )
                    .to.emit(creditContract, "DrawdownMade")
                    .withArgs(borrower.address, borrowAmount, netBorrowAmount);
                let borrowerNewBalance = await mockTokenContract.balanceOf(borrower.address);
                let poolSafeNewBalance = await mockTokenContract.balanceOf(
                    poolSafeContract.address,
                );
                expect(borrowerNewBalance.sub(borrowerOldBalance)).to.equal(netBorrowAmount);
                expect(poolSafeOldBalance.sub(poolSafeNewBalance)).to.equal(netBorrowAmount);

                creditRecord = await creditContract.getCreditRecord(creditHash);
                checkCreditRecord(
                    creditRecord,
                    totalBorrowAmount,
                    nextDueDate,
                    totalYieldDue,
                    totalYieldDue,
                    BN.from(0),
                    0,
                    remainingPeriods,
                    3,
                );
                dueDetail = await creditContract.getDueDetail(creditHash);
                checkDueDetailsMatch(
                    dueDetail,
                    genDueDetail({ accrued: totalYieldDue, committed: committed }),
                );
                expect(await creditContract.maturityDates(creditHash)).to.equal(maturityDate);
            });
        });

        describe("With principalRate", function () {
            const principalRateInBps = 100;
            async function prepareForDrawdown() {
                await poolConfigContract.connect(poolOwner).setFeeStructure({
                    yieldInBps: 0,
                    minPrincipalRateInBps: principalRateInBps,
                    lateFeeFlat: 0,
                    lateFeeBps: 0,
                    membershipFee: 0,
                });

                await creditContract
                    .connect(eaServiceAccount)
                    .approveBorrower(
                        borrower.address,
                        toToken(100_000),
                        numOfPeriods,
                        yieldInBps,
                        toToken(0),
                        true,
                    );
            }

            beforeEach(async function () {
                await loadFixture(prepareForDrawdown);
            });

            it("Should allow the borrower to borrow for the first time while principalRate > 0", async function () {
                const frontLoadingFeeFlat = toToken(100);
                const frontLoadingFeeBps = BN.from(100);
                await poolConfigContract.connect(poolOwner).setFrontLoadingFees({
                    frontLoadingFeeFlat: frontLoadingFeeFlat,
                    frontLoadingFeeBps: frontLoadingFeeBps,
                });

                const creditHash = ethers.utils.keccak256(
                    ethers.utils.defaultAbiCoder.encode(
                        ["address", "address"],
                        [creditContract.address, borrower.address],
                    ),
                );

                const borrowAmount = toToken(50_000);
                const netBorrowAmount = borrowAmount
                    .mul(CONSTANTS.BP_FACTOR.sub(frontLoadingFeeBps))
                    .div(CONSTANTS.BP_FACTOR)
                    .sub(frontLoadingFeeFlat);
                let nextTime = await getFutureBlockTime(3);
                await setNextBlockTimestamp(nextTime);

                let startOfDay = getStartOfDay(nextTime);
                let nextDueDate = await calendarContract.getStartDateOfNextPeriod(
                    CONSTANTS.PERIOD_DURATION_MONTHLY,
                    nextTime,
                );
                let days = (
                    await calendarContract.getDaysDiff(startOfDay, nextDueDate)
                ).toNumber();
                let cc = await creditContract.getCreditConfig(creditHash);
                const [yieldDue] = calcYieldDue(cc, borrowAmount, days, 1, BN.from(0));
                const principalDue = calcPrincipalDueForPartialPeriod(
                    borrowAmount,
                    principalRateInBps,
                    days,
                    30,
                );
                const totalDue = yieldDue.add(principalDue);

                const borrowerOldBalance = await mockTokenContract.balanceOf(borrower.address);
                const poolSafeOldBalance = await mockTokenContract.balanceOf(
                    poolSafeContract.address,
                );
                await expect(
                    creditContract.connect(borrower).drawdown(borrower.address, borrowAmount),
                )
                    .to.emit(creditContract, "DrawdownMade")
                    .withArgs(borrower.address, borrowAmount, netBorrowAmount)
                    .to.emit(creditContract, "BillRefreshed")
                    .withArgs(creditHash, nextDueDate, totalDue);
                const borrowerNewBalance = await mockTokenContract.balanceOf(borrower.address);
                const poolSafeNewBalance = await mockTokenContract.balanceOf(
                    poolSafeContract.address,
                );
                expect(borrowerNewBalance.sub(borrowerOldBalance)).to.equal(netBorrowAmount);
                expect(poolSafeOldBalance.sub(poolSafeNewBalance)).to.equal(netBorrowAmount);

                const creditRecord = await creditContract.getCreditRecord(creditHash);
                checkCreditRecord(
                    creditRecord,
                    borrowAmount.sub(principalDue),
                    nextDueDate,
                    totalDue,
                    yieldDue,
                    BN.from(0),
                    0,
                    getDate(nextTime) == 1 ? numOfPeriods - 1 : numOfPeriods,
                    3,
                );

                const dueDetail = await creditContract.getDueDetail(creditHash);
                checkDueDetailsMatch(dueDetail, genDueDetail({ accrued: yieldDue }));

                expect(await creditContract.maturityDates(creditHash)).to.equal(
                    getDateAfterMonths(startOfDay, numOfPeriods),
                );
            });

            it("Should allow the borrower to borrow again in the same period while principalRate > 0", async function () {});
        });
    });

    describe("refreshCredit", function () {
        let yieldInBps = 1217;
        let numOfPeriods = 3;
        let committedAmount: BN;
        let borrowAmount: BN;
        let creditHash: string;

        describe("Negative Tests", function () {
            async function prepareForNegativeTests() {
                await creditContract
                    .connect(eaServiceAccount)
                    .approveBorrower(
                        borrower.address,
                        toToken(100_000),
                        numOfPeriods,
                        yieldInBps,
                        toToken(10_000),
                        true,
                    );

                creditHash = ethers.utils.keccak256(
                    ethers.utils.defaultAbiCoder.encode(
                        ["address", "address"],
                        [creditContract.address, borrower.address],
                    ),
                );

                borrowAmount = toToken(20_000);
                await creditContract.connect(borrower).drawdown(borrower.address, borrowAmount);
            }

            beforeEach(async function () {
                await loadFixture(prepareForNegativeTests);
            });

            it("Should not update anything while current timestamp is less than next due date", async function () {
                let creditRecord = await creditContract.getCreditRecord(creditHash);
                await creditContract.refreshCredit(borrower.address);
                checkCreditRecordsMatch(
                    await creditContract.getCreditRecord(creditHash),
                    creditRecord,
                );
            });

            it("Should not update anything while current timestamp is greater than next due date and less than late grace period", async function () {
                let creditRecord = await creditContract.getCreditRecord(creditHash);
                let nextTime = creditRecord.nextDueDate.toNumber() + 3600;
                await setNextBlockTimestamp(nextTime);

                await creditContract.refreshCredit(borrower.address);
                checkCreditRecordsMatch(
                    await creditContract.getCreditRecord(creditHash),
                    creditRecord,
                );
            });

            it("Should not update anything while credit state is Defaulted", async function () {});
        });

        describe("Without settings", function () {
            async function prepareForTestsWithoutSettings() {
                committedAmount = toToken(10_000);
                await creditContract
                    .connect(eaServiceAccount)
                    .approveBorrower(
                        borrower.address,
                        toToken(100_000),
                        numOfPeriods,
                        yieldInBps,
                        committedAmount,
                        true,
                    );

                creditHash = ethers.utils.keccak256(
                    ethers.utils.defaultAbiCoder.encode(
                        ["address", "address"],
                        [creditContract.address, borrower.address],
                    ),
                );
            }

            beforeEach(async function () {
                await loadFixture(prepareForTestsWithoutSettings);
            });

            it("Should update correctly when the credit is delayed by 1 period", async function () {
                borrowAmount = toToken(20_000);
                await creditContract.connect(borrower).drawdown(borrower.address, borrowAmount);

                let creditRecord = await creditContract.getCreditRecord(creditHash);
                let settings = await poolConfigContract.getPoolSettings();
                let nextTime =
                    creditRecord.nextDueDate.toNumber() +
                    settings.latePaymentGracePeriodInDays * CONSTANTS.SECONDS_IN_A_DAY +
                    100;
                await setNextBlockTimestamp(nextTime);

                let nextDueDate = await calendarContract.getStartDateOfNextPeriod(
                    CONSTANTS.PERIOD_DURATION_MONTHLY,
                    nextTime,
                );
                let days = (
                    await calendarContract.getDaysDiff(creditRecord.nextDueDate, nextDueDate)
                ).toNumber();
                let cc = await creditContract.getCreditConfig(creditHash);
                const [yieldDue, committed] = calcYieldDue(cc, borrowAmount, days, 1, BN.from(0));
                let totalPastDue = creditRecord.nextDue;

                const remainingPeriods = creditRecord.remainingPeriods;
                await expect(creditContract.refreshCredit(borrower.address))
                    .to.emit(creditContract, "BillRefreshed")
                    .withArgs(creditHash, nextDueDate, yieldDue);

                let tomorrow = await calendarContract.getStartOfTomorrow();
                creditRecord = await creditContract.getCreditRecord(creditHash);
                checkCreditRecord(
                    creditRecord,
                    borrowAmount,
                    nextDueDate,
                    yieldDue,
                    yieldDue,
                    totalPastDue,
                    1,
                    remainingPeriods - 1,
                    4,
                );

                const dueDetail = await creditContract.getDueDetail(creditHash);
                checkDueDetailsMatch(
                    dueDetail,
                    genDueDetail({
                        lateFeeUpdatedDate: tomorrow,
                        accrued: yieldDue,
                        committed: committed,
                        yieldPastDue: totalPastDue,
                    }),
                );
            });

            it("Should update correctly again in the same period while credit state is Delayed", async function () {
                borrowAmount = toToken(20_000);
                await creditContract.connect(borrower).drawdown(borrower.address, borrowAmount);

                let creditRecord = await creditContract.getCreditRecord(creditHash);
                let settings = await poolConfigContract.getPoolSettings();
                let nextTime =
                    creditRecord.nextDueDate.toNumber() +
                    settings.latePaymentGracePeriodInDays * CONSTANTS.SECONDS_IN_A_DAY +
                    100;
                await setNextBlockTimestamp(nextTime);

                await creditContract.refreshCredit(borrower.address);

                const days = 1 * CONSTANTS.SECONDS_IN_A_DAY;
                nextTime = nextTime + days;
                await setNextBlockTimestamp(nextTime);

                creditRecord = await creditContract.getCreditRecord(creditHash);
                let dueDetail = await creditContract.getDueDetail(creditHash);
                await creditContract.refreshCredit(borrower.address);
                checkCreditRecordsMatch(
                    await creditContract.getCreditRecord(creditHash),
                    creditRecord,
                );
                dueDetail = {
                    ...dueDetail,
                    ...{ lateFeeUpdatedDate: dueDetail.lateFeeUpdatedDate.add(days) },
                };
                checkDueDetailsMatch(await creditContract.getDueDetail(creditHash), dueDetail);
            });

            it.skip("Should update correctly again in the next period while credit state is Delayed", async function () {
                borrowAmount = toToken(20_000);
                await creditContract.connect(borrower).drawdown(borrower.address, borrowAmount);

                let creditRecord = await creditContract.getCreditRecord(creditHash);
                let settings = await poolConfigContract.getPoolSettings();
                let nextTime =
                    creditRecord.nextDueDate.toNumber() +
                    settings.latePaymentGracePeriodInDays * CONSTANTS.SECONDS_IN_A_DAY +
                    100;
                await setNextBlockTimestamp(nextTime);

                let totalPastDue = creditRecord.nextDue;
                await creditContract.refreshCredit(borrower.address);

                creditRecord = await creditContract.getCreditRecord(creditHash);
                nextTime = creditRecord.nextDueDate.toNumber() + 100;
                await setNextBlockTimestamp(nextTime);

                let nextDueDate = await calendarContract.getStartDateOfNextPeriod(
                    CONSTANTS.PERIOD_DURATION_MONTHLY,
                    nextTime,
                );
                let days = (
                    await calendarContract.getDaysDiff(creditRecord.nextDueDate, nextDueDate)
                ).toNumber();
                let cc = await creditContract.getCreditConfig(creditHash);
                const [yieldDue, committed] = calcYieldDue(cc, borrowAmount, days, 1, BN.from(0));

                totalPastDue = totalPastDue.add(creditRecord.nextDue);
                await expect(creditContract.refreshCredit(borrower.address))
                    .to.emit(creditContract, "BillRefreshed")
                    .withArgs(creditHash, nextDueDate, yieldDue);

                const remainingPeriods = creditRecord.remainingPeriods;
                const missingPeriods = creditRecord.missedPeriods;
                creditRecord = await creditContract.getCreditRecord(creditHash);
                checkCreditRecord(
                    creditRecord,
                    borrowAmount,
                    nextDueDate,
                    yieldDue,
                    yieldDue,
                    totalPastDue,
                    missingPeriods + 1,
                    remainingPeriods - 1,
                    4,
                );
            });

            it("Should update correctly for the first time in the last period", async function () {
                borrowAmount = toToken(5_000);
                await creditContract.connect(borrower).drawdown(borrower.address, borrowAmount);

                const maturityDate = await creditContract.maturityDates(creditHash);
                let nextTime = maturityDate.toNumber() - 600;
                await setNextBlockTimestamp(nextTime);

                let startDateOfLastPeriod = await calendarContract.getStartDateOfPeriod(
                    CONSTANTS.PERIOD_DURATION_MONTHLY,
                    nextTime,
                );
                let days = (
                    await calendarContract.getDaysDiff(startDateOfLastPeriod, maturityDate)
                ).toNumber();
                let cc = await creditContract.getCreditConfig(creditHash);
                const [yieldDue, committed] = calcYieldDue(cc, borrowAmount, days, 1, BN.from(0));

                let creditRecord = await creditContract.getCreditRecord(creditHash);
                let totalPastDue = creditRecord.nextDue;
                totalPastDue = totalPastDue.add(
                    calcYieldDue(
                        cc,
                        committedAmount,
                        (
                            await calendarContract.getDaysDiff(
                                creditRecord.nextDueDate,
                                startDateOfLastPeriod,
                            )
                        ).toNumber(),
                        1,
                        BN.from(0),
                    )[0],
                );

                const remainingPeriods = creditRecord.remainingPeriods;
                await expect(creditContract.refreshCredit(borrower.address))
                    .to.emit(creditContract, "BillRefreshed")
                    .withArgs(creditHash, maturityDate, committed);

                // let tomorrow = await calendarContract.getStartOfTomorrow();
                creditRecord = await creditContract.getCreditRecord(creditHash);
                checkCreditRecord(
                    creditRecord,
                    borrowAmount,
                    maturityDate,
                    committed,
                    committed,
                    totalPastDue,
                    remainingPeriods,
                    0,
                    4,
                );

                const dueDetail = await creditContract.getDueDetail(creditHash);
                checkDueDetailsMatch(
                    dueDetail,
                    genDueDetail({
                        lateFeeUpdatedDate: maturityDate,
                        accrued: yieldDue,
                        committed: committed,
                        yieldPastDue: totalPastDue,
                    }),
                );
            });

            it("Should update correctly for the first time after maturity date", async function () {});
        });

        describe("With Settings(principalRate, membershipFee, lateFeeInBps)", function () {
            const principalRate = 100;
            const lateFeeFlat = 0;
            const lateFeeBps = 2400;
            let membershipFee: BN;

            async function prepareForTestsWithSettings() {
                membershipFee = toToken(100);
                await poolConfigContract.connect(poolOwner).setFeeStructure({
                    yieldInBps: yieldInBps,
                    minPrincipalRateInBps: principalRate,
                    lateFeeFlat: lateFeeFlat,
                    lateFeeBps: lateFeeBps,
                    membershipFee: membershipFee,
                });

                committedAmount = toToken(10_000);
                await creditContract
                    .connect(eaServiceAccount)
                    .approveBorrower(
                        borrower.address,
                        toToken(100_000),
                        numOfPeriods,
                        yieldInBps,
                        committedAmount,
                        true,
                    );

                creditHash = ethers.utils.keccak256(
                    ethers.utils.defaultAbiCoder.encode(
                        ["address", "address"],
                        [creditContract.address, borrower.address],
                    ),
                );
            }

            beforeEach(async function () {
                await loadFixture(prepareForTestsWithSettings);
            });

            it("Should update correctly while credit delayed 1 period", async function () {
                borrowAmount = toToken(5_000);
                await creditContract.connect(borrower).drawdown(borrower.address, borrowAmount);

                let creditRecord = await creditContract.getCreditRecord(creditHash);
                let settings = await poolConfigContract.getPoolSettings();
                let nextTime =
                    creditRecord.nextDueDate.toNumber() +
                    settings.latePaymentGracePeriodInDays * CONSTANTS.SECONDS_IN_A_DAY +
                    100;
                await setNextBlockTimestamp(nextTime);

                let nextDueDate = await calendarContract.getStartDateOfNextPeriod(
                    CONSTANTS.PERIOD_DURATION_MONTHLY,
                    nextTime,
                );
                let days = (
                    await calendarContract.getDaysDiff(creditRecord.nextDueDate, nextDueDate)
                ).toNumber();
                let cc = await creditContract.getCreditConfig(creditHash);
                const [yieldDue, committed] = calcYieldDue(
                    cc,
                    borrowAmount,
                    days,
                    1,
                    membershipFee,
                );
                let principalDue = calcPrincipalDueForFullPeriods(
                    creditRecord.unbilledPrincipal,
                    principalRate,
                    1,
                );
                let nextDue = committed.add(principalDue);

                await expect(creditContract.refreshCredit(borrower.address))
                    .to.emit(creditContract, "BillRefreshed")
                    .withArgs(creditHash, nextDueDate, nextDue);

                let tomorrow = await calendarContract.getStartOfTomorrow();
                let lateFee = calcYield(
                    borrowAmount,
                    lateFeeBps,
                    (
                        await calendarContract.getDaysDiff(creditRecord.nextDueDate, tomorrow)
                    ).toNumber(),
                );

                let newCreditRecord = await creditContract.getCreditRecord(creditHash);
                checkCreditRecord(
                    newCreditRecord,
                    creditRecord.unbilledPrincipal.sub(principalDue),
                    nextDueDate,
                    nextDue,
                    committed,
                    creditRecord.nextDue.add(lateFee),
                    1,
                    creditRecord.remainingPeriods - 1,
                    4,
                );

                const dueDetail = await creditContract.getDueDetail(creditHash);
                checkDueDetailsMatch(
                    dueDetail,
                    genDueDetail({
                        lateFeeUpdatedDate: tomorrow,
                        lateFee: lateFee,
                        accrued: yieldDue,
                        committed: committed,
                        yieldPastDue: creditRecord.yieldDue,
                        principalPastDue: creditRecord.nextDue.sub(creditRecord.yieldDue),
                    }),
                );
            });

            it("Should update correctly for the first time in the last period", async function () {
                borrowAmount = toToken(20_000);
                await creditContract.connect(borrower).drawdown(borrower.address, borrowAmount);

                const maturityDate = await creditContract.maturityDates(creditHash);
                let nextTime = maturityDate.toNumber() - 600;
                await setNextBlockTimestamp(nextTime);

                let startDateOfLastPeriod = await calendarContract.getStartDateOfPeriod(
                    CONSTANTS.PERIOD_DURATION_MONTHLY,
                    nextTime,
                );
                let days = (
                    await calendarContract.getDaysDiff(startDateOfLastPeriod, maturityDate)
                ).toNumber();
                let cc = await creditContract.getCreditConfig(creditHash);
                const [yieldDue, committed] = calcYieldDue(
                    cc,
                    borrowAmount,
                    days,
                    1,
                    membershipFee,
                );
                let creditRecord = await creditContract.getCreditRecord(creditHash);
                let principalPastDue = calcPrincipalDueForFullPeriods(
                    creditRecord.unbilledPrincipal,
                    principalRate,
                    creditRecord.remainingPeriods - 1,
                );
                const periodsOverdue = await calendarContract.getNumPeriodsPassed(
                    CONSTANTS.PERIOD_DURATION_MONTHLY,
                    creditRecord.nextDueDate,
                    startDateOfLastPeriod,
                );
                let yieldPastDue = calcYield(
                    borrowAmount,
                    yieldInBps,
                    (
                        await calendarContract.getDaysDiff(
                            creditRecord.nextDueDate,
                            startDateOfLastPeriod,
                        )
                    ).toNumber(),
                )
                    .add(creditRecord.yieldDue)
                    .add(membershipFee.mul(periodsOverdue));
                let unbilledPrincipal = creditRecord.unbilledPrincipal.sub(principalPastDue);
                let principalDue = calcPrincipalDueForPartialPeriod(
                    unbilledPrincipal,
                    principalRate,
                    days,
                    30,
                );
                principalPastDue = principalPastDue.add(
                    creditRecord.nextDue.sub(creditRecord.yieldDue),
                );
                let nextDue = yieldDue.add(principalDue);

                await expect(creditContract.refreshCredit(borrower.address))
                    .to.emit(creditContract, "BillRefreshed")
                    .withArgs(creditHash, maturityDate, nextDue);

                let tomorrow = await calendarContract.getStartOfTomorrow();
                let lateFee = calcYield(
                    borrowAmount,
                    lateFeeBps,
                    (
                        await calendarContract.getDaysDiff(creditRecord.nextDueDate, tomorrow)
                    ).toNumber(),
                );

                let newCreditRecord = await creditContract.getCreditRecord(creditHash);
                checkCreditRecord(
                    newCreditRecord,
                    unbilledPrincipal.sub(principalDue),
                    maturityDate,
                    nextDue,
                    yieldDue,
                    yieldPastDue.add(principalPastDue).add(lateFee),
                    creditRecord.remainingPeriods,
                    0,
                    4,
                );

                const dueDetail = await creditContract.getDueDetail(creditHash);
                checkDueDetailsMatch(
                    dueDetail,
                    genDueDetail({
                        lateFeeUpdatedDate: tomorrow,
                        lateFee: lateFee,
                        accrued: yieldDue,
                        committed: committed,
                        yieldPastDue: yieldPastDue,
                        principalPastDue: principalPastDue,
                    }),
                );
            });

            it("Should update correctly again in the next period while credit state is Delayed", async function () {});

            it("Should update correctly for the first time after maturity date", async function () {});
        });
    });

    describe("makePayment", function () {
        const yieldInBps = 1217,
            lateFeeFlat = 0,
            lateFeeBps = 300,
            latePaymentGracePeriodInDays = 5;
        let principalRateInBps: number, membershipFee: BN;
        let borrowAmount: BN, creditHash: string;
        let nextYear: number,
            drawdownDate: moment.Moment,
            makePaymentDate: moment.Moment,
            firstDueDate: moment.Moment;

        beforeEach(function () {
            membershipFee = toToken(10);
            creditHash = ethers.utils.keccak256(
                ethers.utils.defaultAbiCoder.encode(
                    ["address", "address"],
                    [creditContract.address, borrower.address],
                ),
            );
        });

        async function approveCredit() {
            await poolConfigContract.connect(poolOwner).setLatePaymentGracePeriodInDays(5);

            await creditContract
                .connect(eaServiceAccount)
                .approveBorrower(
                    borrower.getAddress(),
                    toToken(100_000),
                    6,
                    yieldInBps,
                    toToken(100_000),
                    true,
                );
        }

        async function drawdown() {
            // Make sure the borrower has enough first loss cover so that they
            // can drawdown.
            await borrowerFirstLossCoverContract
                .connect(borrower)
                .depositCover(
                    await getMinFirstLossCoverRequirement(
                        borrowerFirstLossCoverContract,
                        poolConfigContract,
                        poolContract,
                        await borrower.getAddress(),
                    ),
                );

            // Make the time of drawdown deterministic by using a fixed date
            // in the next year.
            nextYear = moment.utc().year() + 1;
            drawdownDate = moment.utc({
                year: nextYear,
                month: 1,
                day: 12,
                hour: 13,
                minute: 47,
                second: 8,
            });
            await setNextBlockTimestamp(drawdownDate.unix());

            borrowAmount = toToken(50_000);
            await creditContract.connect(borrower).drawdown(borrower.address, borrowAmount);

            firstDueDate = moment.utc({
                year: nextYear,
                month: 2,
                day: 1,
            });
        }

        describe("If the borrower does not have a credit line approved", function () {
            it("Should not allow a borrower to make payment", async function () {
                await expect(
                    creditContract
                        .connect(borrower)
                        .makePayment(borrower.getAddress(), toToken(1)),
                ).to.be.revertedWithCustomError(creditContract, "notBorrower");
            });
        });

        describe("If the borrower has not drawn down from the credit line", function () {
            beforeEach(async function () {
                await loadFixture(approveCredit);
            });

            it("Should not allow the borrower to make payment", async function () {
                await expect(
                    creditContract
                        .connect(borrower)
                        .makePayment(borrower.getAddress(), toToken(1)),
                ).to.be.revertedWithCustomError(
                    creditContract,
                    "creditLineNotInStateForMakingPayment",
                );
            });
        });

        describe("If the borrower has drawn down from the credit line", function () {
            async function testMakePayment(
                paymentAmount: BN,
                paymentDate: moment.Moment = makePaymentDate,
            ) {
                const cc = await creditContract.getCreditConfig(creditHash);
                const cr = await creditContract.getCreditRecord(creditHash);
                const dd = await creditContract.getDueDetail(creditHash);
                const maturityDate = moment.utc(
                    (await creditContract.maturityDates(creditHash)).toNumber() * 1000,
                );

                // Calculate the dues, fees and dates right before the payment is made.
                let [
                    remainingUnbilledPrincipal,
                    remainingPrincipalPastDue,
                    remainingPrincipalNextDue,
                ] = await calcPrincipalDueNew(
                    calendarContract,
                    cc,
                    cr,
                    dd,
                    paymentDate,
                    maturityDate,
                    latePaymentGracePeriodInDays,
                    principalRateInBps,
                );
                let [
                    remainingYieldPastDue,
                    remainingYieldNextDue,
                    [accruedYieldNextDue, committedYieldNextDue],
                ] = await calcYieldDueNew(
                    calendarContract,
                    cc,
                    cr,
                    dd,
                    paymentDate,
                    maturityDate,
                    latePaymentGracePeriodInDays,
                    membershipFee,
                );
                let [lateFeeUpdatedDate, remainingLateFee] = await calcLateFeeNew(
                    poolConfigContract,
                    calendarContract,
                    cc,
                    cr,
                    dd,
                    paymentDate,
                    latePaymentGracePeriodInDays,
                );
                let nextDueBefore = remainingPrincipalNextDue.add(remainingYieldNextDue);

                let principalDuePaid = BN.from(0),
                    yieldDuePaid = BN.from(0),
                    unbilledPrincipalPaid = BN.from(0),
                    principalPastDuePaid = BN.from(0),
                    yieldPastDuePaid = BN.from(0),
                    lateFeePaid = BN.from(0),
                    remainingPaymentAmount = paymentAmount;
                // If there is past due, attempt to pay past due first.
                let remainingPastDue = remainingPrincipalPastDue
                    .add(remainingYieldPastDue)
                    .add(remainingLateFee);
                if (remainingPastDue.gt(0)) {
                    if (paymentAmount.gte(remainingPastDue)) {
                        yieldPastDuePaid = remainingYieldPastDue;
                        remainingYieldPastDue = BN.from(0);
                        principalPastDuePaid = remainingPrincipalPastDue;
                        remainingPrincipalPastDue = BN.from(0);
                        lateFeePaid = remainingLateFee;
                        remainingLateFee = BN.from(0);
                        remainingPaymentAmount = paymentAmount.sub(remainingPastDue);
                    } else if (
                        paymentAmount.gte(remainingYieldPastDue.add(remainingPrincipalPastDue))
                    ) {
                        lateFeePaid = paymentAmount
                            .sub(remainingYieldPastDue)
                            .sub(remainingPrincipalPastDue);
                        remainingLateFee = remainingLateFee.sub(lateFeePaid);
                        yieldPastDuePaid = remainingYieldPastDue;
                        remainingYieldPastDue = BN.from(0);
                        principalPastDuePaid = remainingPrincipalPastDue;
                        remainingPrincipalPastDue = BN.from(0);
                        remainingPaymentAmount = BN.from(0);
                    } else if (paymentAmount.gte(remainingYieldPastDue)) {
                        principalPastDuePaid = paymentAmount.sub(remainingYieldPastDue);
                        remainingPrincipalPastDue =
                            remainingPrincipalPastDue.sub(principalPastDuePaid);
                        yieldPastDuePaid = remainingYieldPastDue;
                        remainingYieldPastDue = BN.from(0);
                        remainingPaymentAmount = BN.from(0);
                    } else {
                        yieldPastDuePaid = paymentAmount;
                        remainingYieldPastDue = remainingYieldPastDue.sub(paymentAmount);
                        remainingPaymentAmount = BN.from(0);
                    }
                    remainingPastDue = remainingPrincipalPastDue
                        .add(remainingYieldPastDue)
                        .add(remainingLateFee);
                }
                // Then pay next due.
                let nextDueAfter = nextDueBefore;
                if (remainingPaymentAmount.gt(0)) {
                    if (remainingPaymentAmount.gte(nextDueBefore)) {
                        yieldDuePaid = remainingYieldNextDue;
                        principalDuePaid = remainingPrincipalNextDue;
                        remainingPaymentAmount = remainingPaymentAmount.sub(nextDueBefore);
                        remainingYieldNextDue = BN.from(0);
                        remainingPrincipalNextDue = BN.from(0);
                        unbilledPrincipalPaid = minBigNumber(
                            remainingUnbilledPrincipal,
                            remainingPaymentAmount,
                        );
                        remainingUnbilledPrincipal =
                            remainingUnbilledPrincipal.sub(unbilledPrincipalPaid);
                        remainingPaymentAmount = remainingPaymentAmount.sub(unbilledPrincipalPaid);
                    } else if (remainingPaymentAmount.gte(remainingYieldNextDue)) {
                        yieldDuePaid = remainingYieldNextDue;
                        principalDuePaid = remainingPaymentAmount.sub(remainingYieldNextDue);
                        remainingPrincipalNextDue = remainingPrincipalNextDue.sub(
                            remainingPaymentAmount.sub(remainingYieldNextDue),
                        );
                        remainingYieldNextDue = BN.from(0);
                        remainingPaymentAmount = BN.from(0);
                    } else {
                        yieldDuePaid = remainingPaymentAmount;
                        remainingYieldNextDue = remainingYieldNextDue.sub(remainingPaymentAmount);
                        remainingPaymentAmount = BN.from(0);
                    }
                    nextDueAfter = remainingYieldNextDue.add(remainingPrincipalNextDue);
                }

                // Clear late fee updated date if the bill is paid off
                if (remainingPastDue.isZero() && nextDueAfter.isZero()) {
                    lateFeeUpdatedDate = BN.from(0);
                }

                let newDueDate;
                if (
                    paymentDate.isSameOrBefore(
                        getNextBillRefreshDate(cr, paymentDate, latePaymentGracePeriodInDays),
                    )
                ) {
                    newDueDate = cr.nextDueDate;
                } else {
                    newDueDate = await getNextDueDate(
                        calendarContract,
                        cc,
                        paymentDate,
                        maturityDate,
                    );
                }
                const paymentAmountUsed = paymentAmount.sub(remainingPaymentAmount);

                const borrowerBalanceBefore = await mockTokenContract.balanceOf(
                    borrower.getAddress(),
                );
                const poolSafeBalanceBefore = await mockTokenContract.balanceOf(
                    poolSafeContract.address,
                );

                console.log(
                    `paymentAmountUsed ${paymentAmountUsed}`,
                    `newDueDate ${newDueDate}`,
                    `nextDueAfter ${nextDueAfter}`,
                    `remainingPastDue ${remainingPastDue}`,
                    `remainingUnbilledPrincipal ${remainingUnbilledPrincipal}`,
                    `principalDuePaid ${principalDuePaid}`,
                    `yieldDuePaid ${yieldDuePaid}`,
                    `unbilledPrincipalPaid ${unbilledPrincipalPaid}`,
                    `principalPastDuePaid ${principalPastDuePaid}`,
                    `yieldPastDuePaid ${yieldPastDuePaid}`,
                    `lateFeePaid ${lateFeePaid}`,
                );
                if (paymentAmountUsed.gt(ethers.constants.Zero)) {
                    await expect(
                        creditContract
                            .connect(borrower)
                            .makePayment(borrower.getAddress(), paymentAmount),
                    )
                        .to.emit(creditContract, "PaymentMade")
                        .withArgs(
                            await borrower.getAddress(),
                            paymentAmountUsed,
                            newDueDate,
                            nextDueAfter,
                            remainingPastDue,
                            remainingUnbilledPrincipal,
                            principalDuePaid,
                            yieldDuePaid,
                            unbilledPrincipalPaid,
                            principalPastDuePaid,
                            yieldPastDuePaid,
                            lateFeePaid,
                            await borrower.getAddress(),
                        );
                } else {
                    await expect(
                        creditContract
                            .connect(borrower)
                            .makePayment(borrower.getAddress(), paymentAmount),
                    ).not.to.emit(creditContract, "PaymentMade");
                }

                // Make sure the funds has been transferred from the borrower to the pool safe.
                const borrowerBalanceAfter = await mockTokenContract.balanceOf(
                    borrower.getAddress(),
                );
                expect(borrowerBalanceBefore.sub(borrowerBalanceAfter)).to.equal(
                    paymentAmountUsed,
                );
                const poolSafeBalanceAfter = await mockTokenContract.balanceOf(
                    poolSafeContract.address,
                );
                expect(poolSafeBalanceAfter.sub(poolSafeBalanceBefore)).to.equal(
                    paymentAmountUsed,
                );

                const newCR = await creditContract.getCreditRecord(creditHash);
                let periodsPassed = 0;
                if (cr.state === CreditState.Approved) {
                    periodsPassed = 1;
                } else if (cr.state === CreditState.GoodStanding) {
                    if (
                        paymentDate.isAfter(
                            getLatePaymentGracePeriodDeadline(cr, latePaymentGracePeriodInDays),
                        )
                    ) {
                        periodsPassed = (
                            await calendarContract.getNumPeriodsPassed(
                                cc.periodDuration,
                                cr.nextDueDate,
                                paymentDate.unix(),
                            )
                        ).toNumber();
                    }
                } else if (paymentDate.isAfter(moment.utc(cr.nextDueDate.toNumber() * 1000))) {
                    periodsPassed = (
                        await calendarContract.getNumPeriodsPassed(
                            cc.periodDuration,
                            cr.nextDueDate,
                            paymentDate.unix(),
                        )
                    ).toNumber();
                }
                const remainingPeriods = Math.max(cr.remainingPeriods - periodsPassed, 0);
                // Whether the bill is late up until payment is made.
                const isLate =
                    cr.missedPeriods > 0 ||
                    (cr.nextDue.gt(0) &&
                        paymentDate.isAfter(
                            getLatePaymentGracePeriodDeadline(cr, latePaymentGracePeriodInDays),
                        ));
                const missedPeriods =
                    !isLate || (nextDueAfter.isZero() && remainingPastDue.isZero())
                        ? 0
                        : cr.missedPeriods + periodsPassed;
                let creditState;
                if (
                    remainingPeriods === 0 &&
                    remainingUnbilledPrincipal.isZero() &&
                    nextDueAfter.isZero() &&
                    remainingPastDue.isZero()
                ) {
                    creditState = CreditState.Deleted;
                } else if (missedPeriods !== 0) {
                    creditState = CreditState.Delayed;
                } else {
                    creditState = CreditState.GoodStanding;
                }
                const expectedNewCR = {
                    unbilledPrincipal: remainingUnbilledPrincipal,
                    nextDueDate: newDueDate,
                    nextDue: nextDueAfter,
                    yieldDue: remainingYieldNextDue,
                    totalPastDue: remainingPastDue,
                    missedPeriods: missedPeriods,
                    remainingPeriods,
                    state: creditState,
                };
                await checkCreditRecordsMatch(newCR, expectedNewCR);

                const newDD = await creditContract.getDueDetail(creditHash);
                const yieldPaidInCurrentCycle =
                    newDueDate === cr.nextDueDate ? dd.paid.add(yieldDuePaid) : yieldDuePaid;
                const expectedNewDD = {
                    lateFeeUpdatedDate,
                    lateFee: remainingLateFee,
                    principalPastDue: remainingPrincipalPastDue,
                    yieldPastDue: remainingYieldPastDue,
                    accrued: accruedYieldNextDue,
                    committed: committedYieldNextDue,
                    paid: yieldPaidInCurrentCycle,
                };
                await checkDueDetailsMatch(newDD, expectedNewDD);
            }

            describe("If the principal rate is zero", function () {
                async function prepareForMakePayment() {
                    principalRateInBps = 0;
                    await poolConfigContract.connect(poolOwner).setFeeStructure({
                        yieldInBps,
                        minPrincipalRateInBps: principalRateInBps,
                        lateFeeFlat,
                        lateFeeBps,
                        membershipFee,
                    });
                    await approveCredit();
                    await drawdown();
                }

                beforeEach(async function () {
                    await loadFixture(prepareForMakePayment);
                });

                describe("If the bill is currently in good standing", function () {
                    describe("When the payment is made within the current billing cycle", function () {
                        async function prepareForMakePaymentInCurrentBillingCycle() {
                            makePaymentDate = moment.utc({
                                year: nextYear,
                                month: 1,
                                day: 28,
                                hour: 21,
                                minute: 35,
                                second: 54,
                            });
                            await setNextBlockTimestamp(makePaymentDate.unix());
                        }

                        beforeEach(async function () {
                            await loadFixture(prepareForMakePaymentInCurrentBillingCycle);
                        });

                        it("Should allow the borrower to make partial payment that covers part of yield next due", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const paymentAmount = yieldNextDue.sub(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make full payment that covers part of all of next due and part of unbilled principal", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const paymentAmount = yieldNextDue.add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to payoff the bill", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const paymentAmount = yieldNextDue.add(borrowAmount);
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make payment that covers the entire bill, and only the pay off amount is collected", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const paymentAmount = yieldNextDue.add(borrowAmount).add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make multiple payments", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );

                            // Make a series of payment gradually and eventually pay off the bill.
                            await testMakePayment(yieldNextDue);

                            const secondPaymentDate = moment.utc({
                                year: nextYear,
                                month: 1,
                                day: 28,
                                hour: 3,
                                minute: 22,
                                second: 57,
                            });
                            setNextBlockTimestamp(secondPaymentDate.unix());
                            await testMakePayment(borrowAmount, secondPaymentDate);

                            const thirdPaymentDate = moment.utc({
                                year: nextYear,
                                month: 1,
                                day: 28,
                                hour: 18,
                                minute: 30,
                            });
                            setNextBlockTimestamp(thirdPaymentDate.unix());
                            await testMakePayment(toToken(1), thirdPaymentDate);
                        });
                    });

                    describe("When the payment is made after the due date of the current billing cycle, but within the late payment grace period", function () {
                        async function prepareForMakePaymentWithinLatePaymentGracePeriod() {
                            makePaymentDate = firstDueDate
                                .clone()
                                .add(latePaymentGracePeriodInDays, "days")
                                .subtract(1, "second");
                            await setNextBlockTimestamp(makePaymentDate.unix());
                        }

                        beforeEach(async function () {
                            await loadFixture(prepareForMakePaymentWithinLatePaymentGracePeriod);
                        });

                        it("Should allow the borrower to make partial payment that covers part of yield next due", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const paymentAmount = yieldNextDue.sub(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make full payment that covers part of all of next due and part of unbilled principal", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const paymentAmount = yieldNextDue.add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to payoff the bill", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const paymentAmount = yieldNextDue.add(borrowAmount);
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make payment that covers the entire bill, and only the pay off amount is collected", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const paymentAmount = yieldNextDue.add(borrowAmount).add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make multiple payments", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            let cr = await creditContract.getCreditRecord(creditHash);
                            let dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            let [, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );

                            // Make a series of payment gradually and eventually pay off the bill.
                            await testMakePayment(yieldNextDue);

                            // The second payment is made after the late payment grace period of the first due date.
                            // But since there is no next due, there is no late fee. However, there is new
                            // yield due since a new bill is generated.
                            const secondPaymentDate = makePaymentDate
                                .clone()
                                .add(1, "day")
                                .add("4", "hours")
                                .add(5, "minutes");
                            setNextBlockTimestamp(secondPaymentDate.unix());
                            cr = await creditContract.getCreditRecord(creditHash);
                            dd = await creditContract.getDueDetail(creditHash);
                            [, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                secondPaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            await testMakePayment(
                                borrowAmount.add(yieldNextDue),
                                secondPaymentDate,
                            );
                            cr = await creditContract.getCreditRecord(creditHash);
                            expect(cr.unbilledPrincipal).to.equal(0);
                            expect(cr.nextDue).to.equal(0);
                            expect(cr.totalPastDue).to.equal(0);

                            const thirdPaymentDate = secondPaymentDate.clone().add(38, "minutes");
                            setNextBlockTimestamp(thirdPaymentDate.unix());
                            await testMakePayment(toToken(1), thirdPaymentDate);
                        });
                    });

                    describe("When the payment is made after the late payment grace period", function () {
                        async function prepareForMakePaymentAfterLatePaymentGracePeriod() {
                            makePaymentDate = firstDueDate
                                .clone()
                                .add(latePaymentGracePeriodInDays, "days")
                                .add(1, "second");
                            await setNextBlockTimestamp(makePaymentDate.unix());
                        }

                        beforeEach(async function () {
                            await loadFixture(prepareForMakePaymentAfterLatePaymentGracePeriod);
                        });

                        it("Should allow the borrower to make partial payment that covers part of yield past due", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const paymentAmount = yieldPastDue.sub(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make partial payment that covers all of yield past due and part of late fee", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const paymentAmount = yieldPastDue.add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make partial payment that covers all of past due and part of next due", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue.add(lateFee).add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make full payment that covers all of past and next due", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue.add(lateFee).add(yieldNextDue);
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to payoff the bill", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue
                                .add(lateFee)
                                .add(yieldNextDue)
                                .add(borrowAmount);
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make payment that covers the entire bill, and only the pay off amount is collected", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue
                                .add(yieldNextDue)
                                .add(lateFee)
                                .add(borrowAmount)
                                .add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make multiple payments", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );

                            await testMakePayment(yieldPastDue);

                            const secondPaymentDate = makePaymentDate
                                .clone()
                                .add(1, "day")
                                .add("4", "hours")
                                .add(5, "minutes");
                            setNextBlockTimestamp(secondPaymentDate.unix());
                            await testMakePayment(lateFee, secondPaymentDate);

                            const thirdPaymentDate = secondPaymentDate
                                .clone()
                                .add("39", "seconds");
                            setNextBlockTimestamp(thirdPaymentDate.unix());
                            await testMakePayment(yieldNextDue, thirdPaymentDate);

                            const fourthPaymentDate = thirdPaymentDate.clone().add("11", "hours");
                            setNextBlockTimestamp(fourthPaymentDate.unix());
                            await testMakePayment(borrowAmount, fourthPaymentDate);

                            const fifthPaymentDate = fourthPaymentDate
                                .clone()
                                .add(2, "days")
                                .add("21", "hours")
                                .add(1, "second");
                            setNextBlockTimestamp(fifthPaymentDate.unix());
                            await testMakePayment(toToken(1), fifthPaymentDate);
                        });
                    });

                    describe("When the payment is in the final period", function () {
                        async function prepareForMakePaymentInFinalPeriod() {
                            makePaymentDate = moment.utc({
                                year: nextYear,
                                month: 7,
                                day: 12,
                            });
                            await setNextBlockTimestamp(makePaymentDate.unix());
                        }

                        beforeEach(async function () {
                            await loadFixture(prepareForMakePaymentInFinalPeriod);
                        });

                        it("Should allow the borrower to make partial payment that covers part of yield past due", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const paymentAmount = yieldPastDue.sub(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make partial payment that covers all of yield past due and part of late fee", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const paymentAmount = yieldPastDue.add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make partial payment that covers all of past due and part of next due", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue.add(lateFee).add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make full payment that covers all of past and next due", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue.add(lateFee).add(yieldNextDue);
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to payoff the bill and close the credit line", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue
                                .add(lateFee)
                                .add(yieldNextDue)
                                .add(borrowAmount);
                            await testMakePayment(paymentAmount);

                            // Payment should no longer be allowed after the credit line is deleted.
                            await expect(
                                creditContract
                                    .connect(borrower)
                                    .makePayment(borrower.getAddress(), paymentAmount),
                            ).to.be.revertedWithCustomError(
                                creditContract,
                                "creditLineNotInStateForMakingPayment",
                            );
                        });

                        it("Should allow the borrower to make payment that covers the entire bill, and only the pay off amount is collected", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue
                                .add(yieldNextDue)
                                .add(lateFee)
                                .add(borrowAmount)
                                .add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it.skip("Should allow the borrower to make multiple payments", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            let cr = await creditContract.getCreditRecord(creditHash);
                            let dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );

                            await testMakePayment(yieldPastDue);

                            const secondPaymentDate = makePaymentDate
                                .clone()
                                .add(1, "day")
                                .add("4", "hours")
                                .add(5, "minutes");
                            cr = await creditContract.getCreditRecord(creditHash);
                            dd = await creditContract.getDueDetail(creditHash);
                            console.log("Calculating second late fee");
                            let [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                secondPaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            setNextBlockTimestamp(secondPaymentDate.unix());
                            await testMakePayment(lateFee, secondPaymentDate);

                            const thirdPaymentDate = secondPaymentDate
                                .clone()
                                .add("39", "seconds");
                            cr = await creditContract.getCreditRecord(creditHash);
                            dd = await creditContract.getDueDetail(creditHash);
                            [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                thirdPaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            setNextBlockTimestamp(thirdPaymentDate.unix());
                            await testMakePayment(yieldNextDue.add(lateFee), thirdPaymentDate);

                            const fourthPaymentDate = thirdPaymentDate.clone().add("11", "hours");
                            cr = await creditContract.getCreditRecord(creditHash);
                            dd = await creditContract.getDueDetail(creditHash);
                            [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                fourthPaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            setNextBlockTimestamp(fourthPaymentDate.unix());
                            await testMakePayment(borrowAmount.add(lateFee), fourthPaymentDate);

                            const fifthPaymentDate = fourthPaymentDate
                                .clone()
                                .add(2, "days")
                                .add("21", "hours")
                                .add(1, "second");
                            setNextBlockTimestamp(fifthPaymentDate.unix());
                            await expect(
                                creditContract
                                    .connect(borrower)
                                    .makePayment(borrower.getAddress(), toToken(1)),
                            ).to.be.revertedWithCustomError(
                                creditContract,
                                "creditLineNotInStateForMakingPayment",
                            );
                        });
                    });

                    describe("When the payment is made after the maturity date", function () {
                        async function prepareForMakePaymentAfterMaturityDate() {
                            // The payment is made after the late payment grace period of the maturity date.
                            makePaymentDate = moment.utc({
                                year: nextYear,
                                month: 7,
                                day: 20,
                                second: 1,
                            });
                            await setNextBlockTimestamp(makePaymentDate.unix());
                        }

                        beforeEach(async function () {
                            await loadFixture(prepareForMakePaymentAfterMaturityDate);
                        });

                        it("Should allow the borrower to make partial payment that covers part of yield past due", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const paymentAmount = yieldPastDue.sub(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make partial payment that covers all of yield past due and part of late fee", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const paymentAmount = yieldPastDue.add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to payoff the bill and close the credit line", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue
                                .add(lateFee)
                                .add(yieldNextDue)
                                .add(borrowAmount);
                            await testMakePayment(paymentAmount);

                            // Payment should no longer be allowed after the credit line is deleted.
                            await expect(
                                creditContract
                                    .connect(borrower)
                                    .makePayment(borrower.getAddress(), paymentAmount),
                            ).to.be.revertedWithCustomError(
                                creditContract,
                                "creditLineNotInStateForMakingPayment",
                            );
                        });

                        it("Should allow the borrower to make payment that covers the entire bill, and only the pay off amount is collected", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue
                                .add(yieldNextDue)
                                .add(lateFee)
                                .add(borrowAmount)
                                .add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it.skip("Should allow the borrower to make multiple payments", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            let cr = await creditContract.getCreditRecord(creditHash);
                            let dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );

                            await testMakePayment(yieldPastDue);

                            const secondPaymentDate = makePaymentDate
                                .clone()
                                .add(1, "day")
                                .add("4", "hours")
                                .add(5, "minutes");
                            cr = await creditContract.getCreditRecord(creditHash);
                            dd = await creditContract.getDueDetail(creditHash);
                            let [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                secondPaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            setNextBlockTimestamp(secondPaymentDate.unix());
                            await testMakePayment(lateFee, secondPaymentDate);

                            const thirdPaymentDate = secondPaymentDate
                                .clone()
                                .add("39", "seconds");
                            cr = await creditContract.getCreditRecord(creditHash);
                            dd = await creditContract.getDueDetail(creditHash);
                            [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                thirdPaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            setNextBlockTimestamp(thirdPaymentDate.unix());
                            await testMakePayment(yieldNextDue.add(lateFee), thirdPaymentDate);

                            const fourthPaymentDate = thirdPaymentDate.clone().add("11", "hours");
                            cr = await creditContract.getCreditRecord(creditHash);
                            dd = await creditContract.getDueDetail(creditHash);
                            [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                fourthPaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            setNextBlockTimestamp(fourthPaymentDate.unix());
                            await testMakePayment(borrowAmount.add(lateFee), fourthPaymentDate);

                            const fifthPaymentDate = fourthPaymentDate
                                .clone()
                                .add(2, "days")
                                .add("21", "hours")
                                .add(1, "second");
                            setNextBlockTimestamp(fifthPaymentDate.unix());
                            await expect(
                                creditContract
                                    .connect(borrower)
                                    .makePayment(borrower.getAddress(), toToken(1)),
                            ).to.be.revertedWithCustomError(
                                creditContract,
                                "creditLineNotInStateForMakingPayment",
                            );
                        });
                    });
                });

                describe("If the bill is delayed", function () {
                    async function prepareForLateBillPayment() {
                        // Refresh the credit many cycles after drawdown so that the bill is delayed
                        // at the time payment is made.
                        const billRefreshDate = moment.utc({
                            year: nextYear,
                            month: 3,
                            day: 1,
                            hour: 12,
                            minute: 28,
                        });
                        await setNextBlockTimestamp(billRefreshDate.unix());
                        await creditContract.refreshCredit(borrower.getAddress());
                        const cr = await creditContract.getCreditRecord(creditHash);
                        expect(cr.state).to.equal(CreditState.Delayed);
                    }

                    beforeEach(async function () {
                        await loadFixture(prepareForLateBillPayment);
                    });

                    describe("When the payment is made within the current billing cycle", function () {
                        async function prepareForMakePaymentInCurrentBillingCycle() {
                            makePaymentDate = moment.utc({
                                year: nextYear,
                                month: 3,
                                day: 28,
                                hour: 21,
                                minute: 35,
                                second: 54,
                            });
                            await setNextBlockTimestamp(makePaymentDate.unix());
                        }

                        beforeEach(async function () {
                            await loadFixture(prepareForMakePaymentInCurrentBillingCycle);
                        });

                        it("Should allow the borrower to make partial payment that covers part of yield past due", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const paymentAmount = yieldPastDue.sub(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make partial payment that covers all of yield past due and part of late fee", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const paymentAmount = yieldPastDue.add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make partial payment that covers all of past due and part of next due", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue.add(lateFee).add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make full payment that covers all of past and next due", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue.add(lateFee).add(yieldNextDue);
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to payoff the bill", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue
                                .add(lateFee)
                                .add(yieldNextDue)
                                .add(borrowAmount);
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make multiple payments", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            let cr = await creditContract.getCreditRecord(creditHash);
                            let dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );

                            await testMakePayment(yieldPastDue);

                            const secondPaymentDate = makePaymentDate
                                .clone()
                                .add(1, "day")
                                .add("4", "hours")
                                .add(5, "minutes");
                            cr = await creditContract.getCreditRecord(creditHash);
                            dd = await creditContract.getDueDetail(creditHash);
                            let [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                secondPaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            setNextBlockTimestamp(secondPaymentDate.unix());
                            await testMakePayment(lateFee, secondPaymentDate);

                            const thirdPaymentDate = secondPaymentDate
                                .clone()
                                .add("39", "seconds");
                            cr = await creditContract.getCreditRecord(creditHash);
                            dd = await creditContract.getDueDetail(creditHash);
                            [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                thirdPaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            setNextBlockTimestamp(thirdPaymentDate.unix());
                            await testMakePayment(yieldNextDue.add(lateFee), thirdPaymentDate);

                            const fourthPaymentDate = thirdPaymentDate.clone().add("11", "hours");
                            cr = await creditContract.getCreditRecord(creditHash);
                            dd = await creditContract.getDueDetail(creditHash);
                            [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                fourthPaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            expect(lateFee).to.equal(0);
                            setNextBlockTimestamp(fourthPaymentDate.unix());
                            await testMakePayment(borrowAmount.add(lateFee), fourthPaymentDate);

                            const fifthPaymentDate = fourthPaymentDate
                                .clone()
                                .add(2, "days")
                                .add("21", "hours")
                                .add(1, "second");
                            setNextBlockTimestamp(fifthPaymentDate.unix());
                            await testMakePayment(toToken(1), fifthPaymentDate);
                        });
                    });

                    describe("When the payment is made outside of the current billing cycle", function () {
                        async function prepareForMakePaymentAfterLatePaymentGracePeriod() {
                            makePaymentDate = moment.utc({
                                year: nextYear,
                                month: 4,
                                day: 8,
                                minute: 21,
                            });
                            await setNextBlockTimestamp(makePaymentDate.unix());
                        }

                        beforeEach(async function () {
                            await loadFixture(prepareForMakePaymentAfterLatePaymentGracePeriod);
                        });

                        it("Should allow the borrower to make partial payment that covers part of yield past due", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const paymentAmount = yieldPastDue.sub(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make partial payment that covers all of yield and principal past due and part of late fee", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const paymentAmount = yieldPastDue.add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make partial payment that covers all of past due and part of next due", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue.add(lateFee).add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make full payment that covers all of past and next due", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue.add(lateFee).add(yieldNextDue);
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to payoff the bill", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue
                                .add(lateFee)
                                .add(yieldNextDue)
                                .add(borrowAmount);
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make multiple payments", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            let cr = await creditContract.getCreditRecord(creditHash);
                            let dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );

                            await testMakePayment(yieldPastDue);

                            const secondPaymentDate = makePaymentDate
                                .clone()
                                .add(1, "day")
                                .add("4", "hours")
                                .add(5, "minutes");
                            cr = await creditContract.getCreditRecord(creditHash);
                            dd = await creditContract.getDueDetail(creditHash);
                            let [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                secondPaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            setNextBlockTimestamp(secondPaymentDate.unix());
                            await testMakePayment(lateFee, secondPaymentDate);

                            const thirdPaymentDate = secondPaymentDate
                                .clone()
                                .add("39", "seconds");
                            cr = await creditContract.getCreditRecord(creditHash);
                            dd = await creditContract.getDueDetail(creditHash);
                            [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                thirdPaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            setNextBlockTimestamp(thirdPaymentDate.unix());
                            await testMakePayment(yieldNextDue.add(lateFee), thirdPaymentDate);

                            const fourthPaymentDate = thirdPaymentDate.clone().add("11", "hours");
                            cr = await creditContract.getCreditRecord(creditHash);
                            dd = await creditContract.getDueDetail(creditHash);
                            [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                fourthPaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            expect(lateFee).to.equal(0);
                            setNextBlockTimestamp(fourthPaymentDate.unix());
                            await testMakePayment(borrowAmount.add(lateFee), fourthPaymentDate);

                            const fifthPaymentDate = fourthPaymentDate
                                .clone()
                                .add(2, "days")
                                .add("21", "hours")
                                .add(1, "second");
                            setNextBlockTimestamp(fifthPaymentDate.unix());
                            await testMakePayment(toToken(1), fifthPaymentDate);
                        });
                    });
                });
            });

            describe("If the principal rate is non-zero", function () {
                async function prepareForMakePayment() {
                    principalRateInBps = 200;
                    await poolConfigContract.connect(poolOwner).setFeeStructure({
                        yieldInBps,
                        minPrincipalRateInBps: principalRateInBps,
                        lateFeeFlat,
                        lateFeeBps,
                        membershipFee,
                    });
                    await approveCredit();
                    await drawdown();
                }

                beforeEach(async function () {
                    await loadFixture(prepareForMakePayment);
                });

                describe("If the bill is currently in good standing", function () {
                    describe("When the payment is made within the current billing cycle", function () {
                        async function prepareForMakePaymentInCurrentBillingCycle() {
                            makePaymentDate = moment.utc({
                                year: nextYear,
                                month: 1,
                                day: 28,
                                hour: 21,
                                minute: 35,
                                second: 54,
                            });
                            await setNextBlockTimestamp(makePaymentDate.unix());
                        }

                        beforeEach(async function () {
                            await loadFixture(prepareForMakePaymentInCurrentBillingCycle);
                        });

                        it("Should allow the borrower to make partial payment that covers part of yield next due", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const paymentAmount = yieldNextDue.sub(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make partial payment that covers part of all of yield next due and part of principal next due", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const paymentAmount = yieldNextDue.add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make full payment that covers part of all of next due and part of unbilled principal", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const [, , principalNextDue] = await calcPrincipalDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                principalRateInBps,
                            );
                            const paymentAmount = yieldNextDue
                                .add(principalNextDue)
                                .add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to payoff the bill", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const [unbilledPrincipal, , principalNextDue] =
                                await calcPrincipalDueNew(
                                    calendarContract,
                                    cc,
                                    cr,
                                    dd,
                                    makePaymentDate,
                                    moment.utc(maturityDate.toNumber() * 1000),
                                    latePaymentGracePeriodInDays,
                                    principalRateInBps,
                                );
                            const paymentAmount = yieldNextDue
                                .add(principalNextDue)
                                .add(unbilledPrincipal);
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make payment that covers the entire bill, and only the pay off amount is collected", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const [unbilledPrincipal, , principalNextDue] =
                                await calcPrincipalDueNew(
                                    calendarContract,
                                    cc,
                                    cr,
                                    dd,
                                    makePaymentDate,
                                    moment.utc(maturityDate.toNumber() * 1000),
                                    latePaymentGracePeriodInDays,
                                    principalRateInBps,
                                );
                            const paymentAmount = yieldNextDue
                                .add(principalNextDue)
                                .add(unbilledPrincipal)
                                .add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make multiple payments", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const [unbilledPrincipal, , principalNextDue] =
                                await calcPrincipalDueNew(
                                    calendarContract,
                                    cc,
                                    cr,
                                    dd,
                                    makePaymentDate,
                                    moment.utc(maturityDate.toNumber() * 1000),
                                    latePaymentGracePeriodInDays,
                                    principalRateInBps,
                                );

                            // Make a series of payment gradually and eventually pay off the bill.
                            await testMakePayment(yieldNextDue);

                            const secondPaymentDate = moment.utc({
                                year: nextYear,
                                month: 1,
                                day: 28,
                                hour: 3,
                                minute: 22,
                                second: 57,
                            });
                            setNextBlockTimestamp(secondPaymentDate.unix());
                            await testMakePayment(principalNextDue, secondPaymentDate);

                            const thirdPaymentDate = moment.utc({
                                year: nextYear,
                                month: 1,
                                day: 28,
                                hour: 18,
                                minute: 30,
                            });
                            setNextBlockTimestamp(thirdPaymentDate.unix());
                            await testMakePayment(unbilledPrincipal, thirdPaymentDate);

                            const fourthPaymentDate = moment.utc({
                                year: nextYear,
                                month: 1,
                                day: 28,
                                hour: 18,
                                minute: 31,
                            });
                            setNextBlockTimestamp(fourthPaymentDate.unix());
                            await testMakePayment(toToken(1), thirdPaymentDate);
                        });
                    });

                    describe("When the payment is made after the due date of the current billing cycle, but within the late payment grace period", function () {
                        async function prepareForMakePaymentWithinLatePaymentGracePeriod() {
                            makePaymentDate = firstDueDate
                                .clone()
                                .add(latePaymentGracePeriodInDays, "days")
                                .subtract(1, "second");
                            await setNextBlockTimestamp(makePaymentDate.unix());
                        }

                        beforeEach(async function () {
                            await loadFixture(prepareForMakePaymentWithinLatePaymentGracePeriod);
                        });

                        it("Should allow the borrower to make partial payment that covers part of yield next due", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const paymentAmount = yieldNextDue.sub(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make partial payment that covers part of all of yield next due and part of principal next due", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const paymentAmount = yieldNextDue.add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make full payment that covers part of all of next due and part of unbilled principal", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const [, , principalNextDue] = await calcPrincipalDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                principalRateInBps,
                            );
                            const paymentAmount = yieldNextDue
                                .add(principalNextDue)
                                .add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to payoff the bill", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const [unbilledPrincipal, , principalNextDue] =
                                await calcPrincipalDueNew(
                                    calendarContract,
                                    cc,
                                    cr,
                                    dd,
                                    makePaymentDate,
                                    moment.utc(maturityDate.toNumber() * 1000),
                                    latePaymentGracePeriodInDays,
                                    principalRateInBps,
                                );
                            const paymentAmount = yieldNextDue
                                .add(principalNextDue)
                                .add(unbilledPrincipal);
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make payment that covers the entire bill, and only the pay off amount is collected", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const [unbilledPrincipal, , principalNextDue] =
                                await calcPrincipalDueNew(
                                    calendarContract,
                                    cc,
                                    cr,
                                    dd,
                                    makePaymentDate,
                                    moment.utc(maturityDate.toNumber() * 1000),
                                    latePaymentGracePeriodInDays,
                                    principalRateInBps,
                                );
                            const paymentAmount = yieldNextDue
                                .add(principalNextDue)
                                .add(unbilledPrincipal)
                                .add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make multiple payments", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const [unbilledPrincipal, , principalNextDue] =
                                await calcPrincipalDueNew(
                                    calendarContract,
                                    cc,
                                    cr,
                                    dd,
                                    makePaymentDate,
                                    moment.utc(maturityDate.toNumber() * 1000),
                                    latePaymentGracePeriodInDays,
                                    principalRateInBps,
                                );

                            await testMakePayment(yieldNextDue);

                            const secondPaymentDate = makePaymentDate
                                .clone()
                                .add(1, "day")
                                .add("4", "hours")
                                .add(5, "minutes");
                            setNextBlockTimestamp(secondPaymentDate.unix());
                            await testMakePayment(principalNextDue, secondPaymentDate);

                            const thirdPaymentDate = secondPaymentDate.clone().add(38, "minutes");
                            setNextBlockTimestamp(thirdPaymentDate.unix());
                            await testMakePayment(unbilledPrincipal, thirdPaymentDate);

                            const fourthPaymentDate = thirdPaymentDate.clone().add(1, "hour");
                            setNextBlockTimestamp(fourthPaymentDate.unix());
                            await testMakePayment(toToken(1), thirdPaymentDate);
                        });
                    });

                    describe("When the payment is made after the late payment grace period", function () {
                        async function prepareForMakePaymentAfterLatePaymentGracePeriod() {
                            makePaymentDate = firstDueDate
                                .clone()
                                .add(latePaymentGracePeriodInDays, "days")
                                .add(1, "second");
                            await setNextBlockTimestamp(makePaymentDate.unix());
                        }

                        beforeEach(async function () {
                            await loadFixture(prepareForMakePaymentAfterLatePaymentGracePeriod);
                        });

                        it("Should allow the borrower to make partial payment that covers part of yield past due", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const paymentAmount = yieldPastDue.sub(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make partial payment that covers all of yield past due and part of principal past due", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const paymentAmount = yieldPastDue.add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make partial payment that covers all of yield and principal past due and part of late fee", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const [, principalPastDue] = await calcPrincipalDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                principalRateInBps,
                            );
                            const paymentAmount = yieldPastDue
                                .add(principalPastDue)
                                .add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make partial payment that covers all of past due and part of next due", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const [, principalPastDue] = await calcPrincipalDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                principalRateInBps,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue
                                .add(principalPastDue)
                                .add(lateFee)
                                .add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make full payment that covers all of past and next due", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const [principalPastDue, principalNextDue] = await calcPrincipalDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                principalRateInBps,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue
                                .add(principalPastDue)
                                .add(lateFee)
                                .add(yieldNextDue)
                                .add(principalNextDue);
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to payoff the bill", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const [unbilledPrincipal, principalPastDue, principalNextDue] =
                                await calcPrincipalDueNew(
                                    calendarContract,
                                    cc,
                                    cr,
                                    dd,
                                    makePaymentDate,
                                    moment.utc(maturityDate.toNumber() * 1000),
                                    latePaymentGracePeriodInDays,
                                    principalRateInBps,
                                );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue
                                .add(principalPastDue)
                                .add(lateFee)
                                .add(yieldNextDue)
                                .add(principalNextDue)
                                .add(unbilledPrincipal);
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make payment that covers the entire bill, and only the pay off amount is collected", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const [unbilledPrincipal, principalPastDue, principalNextDue] =
                                await calcPrincipalDueNew(
                                    calendarContract,
                                    cc,
                                    cr,
                                    dd,
                                    makePaymentDate,
                                    moment.utc(maturityDate.toNumber() * 1000),
                                    latePaymentGracePeriodInDays,
                                    principalRateInBps,
                                );
                            const paymentAmount = yieldPastDue
                                .add(yieldNextDue)
                                .add(principalPastDue)
                                .add(principalNextDue)
                                .add(unbilledPrincipal)
                                .add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make multiple payments", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const [unbilledPrincipal, principalPastDue, principalNextDue] =
                                await calcPrincipalDueNew(
                                    calendarContract,
                                    cc,
                                    cr,
                                    dd,
                                    makePaymentDate,
                                    moment.utc(maturityDate.toNumber() * 1000),
                                    latePaymentGracePeriodInDays,
                                    principalRateInBps,
                                );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );

                            await testMakePayment(yieldPastDue);

                            const secondPaymentDate = makePaymentDate
                                .clone()
                                .add(1, "day")
                                .add("4", "hours")
                                .add(5, "minutes");
                            setNextBlockTimestamp(secondPaymentDate.unix());
                            await testMakePayment(lateFee, secondPaymentDate);

                            const thirdPaymentDate = secondPaymentDate
                                .clone()
                                .add("39", "seconds");
                            setNextBlockTimestamp(thirdPaymentDate.unix());
                            await testMakePayment(yieldNextDue, thirdPaymentDate);

                            const fourthPaymentDate = thirdPaymentDate.clone().add("11", "hours");
                            setNextBlockTimestamp(fourthPaymentDate.unix());
                            await testMakePayment(principalNextDue, fourthPaymentDate);

                            const fifthPaymentDate = fourthPaymentDate
                                .clone()
                                .add(2, "days")
                                .add("21", "hours")
                                .add(1, "second");
                            setNextBlockTimestamp(fifthPaymentDate.unix());
                            await testMakePayment(unbilledPrincipal, fifthPaymentDate);

                            const sixthPaymentDate = fifthPaymentDate.clone().add(46, "seconds");
                            setNextBlockTimestamp(sixthPaymentDate.unix());
                            await testMakePayment(toToken(1), sixthPaymentDate);
                        });
                    });

                    describe("When the payment is in the final period", function () {
                        async function prepareForMakePaymentInFinalPeriod() {
                            makePaymentDate = moment.utc({
                                year: nextYear,
                                month: 7,
                                day: 12,
                            });
                            await setNextBlockTimestamp(makePaymentDate.unix());
                        }

                        beforeEach(async function () {
                            await loadFixture(prepareForMakePaymentInFinalPeriod);
                        });

                        it("Should allow the borrower to make partial payment that covers part of yield past due", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const paymentAmount = yieldPastDue.sub(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make partial payment that covers all of yield past due and part of principal past due", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const paymentAmount = yieldPastDue.add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make partial payment that covers all of yield and principal past due and part of late fee", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const [, principalPastDue] = await calcPrincipalDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                principalRateInBps,
                            );
                            const paymentAmount = yieldPastDue
                                .add(principalPastDue)
                                .add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make partial payment that covers all of past due and part of next due", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const [, principalPastDue] = await calcPrincipalDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                principalRateInBps,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue
                                .add(principalPastDue)
                                .add(lateFee)
                                .add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make full payment that covers all of past and next due", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const [principalPastDue, principalNextDue] = await calcPrincipalDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                principalRateInBps,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue
                                .add(principalPastDue)
                                .add(lateFee)
                                .add(yieldNextDue)
                                .add(principalNextDue);
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to payoff the bill and close the credit line", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const [unbilledPrincipal, principalPastDue, principalNextDue] =
                                await calcPrincipalDueNew(
                                    calendarContract,
                                    cc,
                                    cr,
                                    dd,
                                    makePaymentDate,
                                    moment.utc(maturityDate.toNumber() * 1000),
                                    latePaymentGracePeriodInDays,
                                    principalRateInBps,
                                );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue
                                .add(principalPastDue)
                                .add(lateFee)
                                .add(yieldNextDue)
                                .add(principalNextDue)
                                .add(unbilledPrincipal);
                            await testMakePayment(paymentAmount);

                            // Payment should no longer be allowed after the credit line is deleted.
                            await expect(
                                creditContract
                                    .connect(borrower)
                                    .makePayment(borrower.getAddress(), paymentAmount),
                            ).to.be.revertedWithCustomError(
                                creditContract,
                                "creditLineNotInStateForMakingPayment",
                            );
                        });

                        it("Should allow the borrower to make payment that covers the entire bill, and only the pay off amount is collected", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const [unbilledPrincipal, principalPastDue, principalNextDue] =
                                await calcPrincipalDueNew(
                                    calendarContract,
                                    cc,
                                    cr,
                                    dd,
                                    makePaymentDate,
                                    moment.utc(maturityDate.toNumber() * 1000),
                                    latePaymentGracePeriodInDays,
                                    principalRateInBps,
                                );
                            const paymentAmount = yieldPastDue
                                .add(yieldNextDue)
                                .add(principalPastDue)
                                .add(principalNextDue)
                                .add(unbilledPrincipal)
                                .add(toToken(1));
                        });
                    });

                    describe("When the payment is made after maturity date", function () {
                        async function prepareForMakePaymentAfterMaturityDate() {
                            makePaymentDate = moment.utc({
                                year: nextYear,
                                month: 7,
                                day: 12,
                                second: 1,
                            });
                            await setNextBlockTimestamp(makePaymentDate.unix());
                        }

                        beforeEach(async function () {
                            await loadFixture(prepareForMakePaymentAfterMaturityDate);
                        });

                        it("Should allow the borrower to make partial payment that covers part of yield past due", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const paymentAmount = yieldPastDue.sub(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make partial payment that covers all of yield past due and part of principal past due", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const paymentAmount = yieldPastDue.add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make partial payment that covers all of yield and principal past due and part of late fee", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const [, principalPastDue] = await calcPrincipalDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                principalRateInBps,
                            );
                            const paymentAmount = yieldPastDue
                                .add(principalPastDue)
                                .add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to payoff the bill and close the credit line", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const [unbilledPrincipal, principalPastDue, principalNextDue] =
                                await calcPrincipalDueNew(
                                    calendarContract,
                                    cc,
                                    cr,
                                    dd,
                                    makePaymentDate,
                                    moment.utc(maturityDate.toNumber() * 1000),
                                    latePaymentGracePeriodInDays,
                                    principalRateInBps,
                                );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue
                                .add(principalPastDue)
                                .add(lateFee)
                                .add(yieldNextDue)
                                .add(principalNextDue)
                                .add(unbilledPrincipal);
                            await testMakePayment(paymentAmount);

                            // Payment should no longer be allowed after the credit line is deleted.
                            await expect(
                                creditContract
                                    .connect(borrower)
                                    .makePayment(borrower.getAddress(), paymentAmount),
                            ).to.be.revertedWithCustomError(
                                creditContract,
                                "creditLineNotInStateForMakingPayment",
                            );
                        });

                        it("Should allow the borrower to make payment that covers the entire bill, and only the pay off amount is collected", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const [unbilledPrincipal, principalPastDue, principalNextDue] =
                                await calcPrincipalDueNew(
                                    calendarContract,
                                    cc,
                                    cr,
                                    dd,
                                    makePaymentDate,
                                    moment.utc(maturityDate.toNumber() * 1000),
                                    latePaymentGracePeriodInDays,
                                    principalRateInBps,
                                );
                            const paymentAmount = yieldPastDue
                                .add(yieldNextDue)
                                .add(principalPastDue)
                                .add(principalNextDue)
                                .add(unbilledPrincipal)
                                .add(toToken(1));
                        });
                    });
                });

                describe("If the bill is delayed", function () {
                    async function prepareForLateBillPayment() {
                        // Refresh the credit many cycles after drawdown so that the bill is delayed
                        // at the time payment is made.
                        const billRefreshDate = moment.utc({
                            year: nextYear,
                            month: 3,
                            day: 1,
                            hour: 12,
                            minute: 28,
                        });
                        await setNextBlockTimestamp(billRefreshDate.unix());
                        await creditContract.refreshCredit(borrower.getAddress());
                        const cr = await creditContract.getCreditRecord(creditHash);
                        expect(cr.state).to.equal(CreditState.Delayed);
                    }

                    beforeEach(async function () {
                        await loadFixture(prepareForLateBillPayment);
                    });

                    describe("When the payment is made within the current billing cycle", function () {
                        async function prepareForMakePaymentInCurrentBillingCycle() {
                            makePaymentDate = moment.utc({
                                year: nextYear,
                                month: 3,
                                day: 28,
                                hour: 21,
                                minute: 35,
                                second: 54,
                            });
                            await setNextBlockTimestamp(makePaymentDate.unix());
                        }

                        beforeEach(async function () {
                            await loadFixture(prepareForMakePaymentInCurrentBillingCycle);
                        });

                        it("Should allow the borrower to make partial payment that covers part of yield past due", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const paymentAmount = yieldPastDue.sub(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make partial payment that covers all of yield past due and part of principal past due", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const paymentAmount = yieldPastDue.add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make partial payment that covers all of yield and principal past due and part of late fee", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const [, principalPastDue] = await calcPrincipalDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                principalRateInBps,
                            );
                            const paymentAmount = yieldPastDue
                                .add(principalPastDue)
                                .add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make partial payment that covers all of past due and part of next due", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const [, principalPastDue] = await calcPrincipalDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                principalRateInBps,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue
                                .add(principalPastDue)
                                .add(lateFee)
                                .add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make full payment that covers all of past and next due", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const [principalPastDue, principalNextDue] = await calcPrincipalDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                principalRateInBps,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue
                                .add(principalPastDue)
                                .add(lateFee)
                                .add(yieldNextDue)
                                .add(principalNextDue);
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to payoff the bill", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const [unbilledPrincipal, principalPastDue, principalNextDue] =
                                await calcPrincipalDueNew(
                                    calendarContract,
                                    cc,
                                    cr,
                                    dd,
                                    makePaymentDate,
                                    moment.utc(maturityDate.toNumber() * 1000),
                                    latePaymentGracePeriodInDays,
                                    principalRateInBps,
                                );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue
                                .add(principalPastDue)
                                .add(lateFee)
                                .add(yieldNextDue)
                                .add(principalNextDue)
                                .add(unbilledPrincipal);
                            await testMakePayment(paymentAmount);
                        });
                    });

                    describe("When the payment is made outside of the current billing cycle", function () {
                        async function prepareForMakePaymentAfterLatePaymentGracePeriod() {
                            makePaymentDate = moment.utc({
                                year: nextYear,
                                month: 4,
                                day: 8,
                                minute: 21,
                            });
                            await setNextBlockTimestamp(makePaymentDate.unix());
                        }

                        beforeEach(async function () {
                            await loadFixture(prepareForMakePaymentAfterLatePaymentGracePeriod);
                        });

                        it("Should allow the borrower to make partial payment that covers part of yield past due", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const paymentAmount = yieldPastDue.sub(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make partial payment that covers all of yield past due and part of principal past due", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const paymentAmount = yieldPastDue.add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make partial payment that covers all of yield and principal past due and part of late fee", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const [, principalPastDue] = await calcPrincipalDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                principalRateInBps,
                            );
                            const paymentAmount = yieldPastDue
                                .add(principalPastDue)
                                .add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make partial payment that covers all of past due and part of next due", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const [, principalPastDue] = await calcPrincipalDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                principalRateInBps,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue
                                .add(principalPastDue)
                                .add(lateFee)
                                .add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make full payment that covers all of past and next due", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const [principalPastDue, principalNextDue] = await calcPrincipalDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                principalRateInBps,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue
                                .add(principalPastDue)
                                .add(lateFee)
                                .add(yieldNextDue)
                                .add(principalNextDue);
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to payoff the bill", async function () {
                            const cc = await creditContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await creditContract.maturityDates(creditHash);

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                membershipFee,
                            );
                            const [unbilledPrincipal, principalPastDue, principalNextDue] =
                                await calcPrincipalDueNew(
                                    calendarContract,
                                    cc,
                                    cr,
                                    dd,
                                    makePaymentDate,
                                    moment.utc(maturityDate.toNumber() * 1000),
                                    latePaymentGracePeriodInDays,
                                    principalRateInBps,
                                );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue
                                .add(principalPastDue)
                                .add(lateFee)
                                .add(yieldNextDue)
                                .add(principalNextDue)
                                .add(unbilledPrincipal);
                            await testMakePayment(paymentAmount);
                        });
                    });
                });

                it("Should not allow payment when the protocol is paused or pool is not on", async function () {
                    await humaConfigContract.connect(protocolOwner).pause();
                    await expect(
                        creditContract.makePayment(borrower.getAddress(), toToken(1)),
                    ).to.be.revertedWithCustomError(poolConfigContract, "protocolIsPaused");
                    await humaConfigContract.connect(protocolOwner).unpause();

                    await poolContract.connect(poolOwner).disablePool();
                    await expect(
                        creditContract.makePayment(borrower.getAddress(), toToken(1)),
                    ).to.be.revertedWithCustomError(poolConfigContract, "poolIsNotOn");
                    await poolContract.connect(poolOwner).enablePool();
                });

                it("Should not allow non-borrower or non-PDS service account to make payment", async function () {
                    await expect(
                        creditContract
                            .connect(borrower2)
                            .makePayment(borrower.getAddress(), toToken(1)),
                    ).to.be.revertedWithCustomError(
                        creditContract,
                        "paymentDetectionServiceAccountRequired",
                    );
                });

                it("Should not allow the borrower to make payment with 0 amount", async function () {
                    await expect(
                        creditContract.connect(borrower).makePayment(borrower.getAddress(), 0),
                    ).to.be.revertedWithCustomError(creditContract, "zeroAmountProvided");
                });
            });
        });
    });

    describe("makePrincipalPayment", function () {
        const yieldInBps = 1217,
            lateFeeFlat = 0,
            lateFeeBps = 300,
            latePaymentGracePeriodInDays = 5;
        let principalRateInBps: number, membershipFee: BN;
        let borrowAmount: BN, creditHash: string;
        let nextYear: number,
            drawdownDate: moment.Moment,
            makePaymentDate: moment.Moment,
            firstDueDate: moment.Moment;

        beforeEach(function () {
            membershipFee = toToken(10);
            creditHash = ethers.utils.keccak256(
                ethers.utils.defaultAbiCoder.encode(
                    ["address", "address"],
                    [creditContract.address, borrower.address],
                ),
            );
        });

        async function approveCredit() {
            await poolConfigContract.connect(poolOwner).setLatePaymentGracePeriodInDays(5);

            await creditContract
                .connect(eaServiceAccount)
                .approveBorrower(
                    borrower.getAddress(),
                    toToken(100_000),
                    6,
                    yieldInBps,
                    toToken(100_000),
                    true,
                );
        }

        async function drawdown() {
            // Make sure the borrower has enough first loss cover so that they
            // can drawdown.
            await borrowerFirstLossCoverContract
                .connect(borrower)
                .depositCover(
                    await getMinFirstLossCoverRequirement(
                        borrowerFirstLossCoverContract,
                        poolConfigContract,
                        poolContract,
                        await borrower.getAddress(),
                    ),
                );

            // Make the time of drawdown deterministic by using a fixed date
            // in the next year.
            nextYear = moment.utc().year() + 1;
            drawdownDate = moment.utc({
                year: nextYear,
                month: 1,
                day: 12,
                hour: 13,
                minute: 47,
                second: 8,
            });
            await setNextBlockTimestamp(drawdownDate.unix());

            borrowAmount = toToken(50_000);
            await creditContract.connect(borrower).drawdown(borrower.address, borrowAmount);

            firstDueDate = moment.utc({
                year: nextYear,
                month: 2,
                day: 1,
            });
        }

        describe("If the borrower does not have a credit line approved", function () {
            it("Should not allow a borrower to make principal payment", async function () {
                await expect(
                    creditContract
                        .connect(borrower)
                        .makePrincipalPayment(borrower.getAddress(), toToken(1)),
                ).to.be.revertedWithCustomError(creditContract, "notBorrower");
            });
        });

        describe("If the borrower has not drawn down from the credit line", function () {
            beforeEach(async function () {
                await loadFixture(approveCredit);
            });

            it("Should not allow the borrower to make principal payment", async function () {
                await expect(
                    creditContract
                        .connect(borrower)
                        .makePrincipalPayment(borrower.getAddress(), toToken(1)),
                ).to.be.revertedWithCustomError(
                    creditContract,
                    "creditLineNotInStateForMakingPrincipalPayment",
                );
            });
        });

        describe("If the borrower has drawn down from the credit line", function () {
            async function testMakePrincipalPayment(
                paymentDate: moment.Moment,
                paymentAmount: BN,
                paymentAmountCollected: BN,
                nextDueDate: moment.Moment,
                principalDuePaid: BN,
                unbilledPrincipalPaid: BN,
                expectedNewCR: CreditRecordStruct,
                expectedNewDD: DueDetailStruct,
            ) {
                await setNextBlockTimestamp(paymentDate.unix());

                const borrowerBalanceBefore = await mockTokenContract.balanceOf(
                    borrower.getAddress(),
                );
                const poolSafeBalanceBefore = await mockTokenContract.balanceOf(
                    poolSafeContract.address,
                );
                if (paymentAmountCollected.gt(0)) {
                    await expect(
                        creditContract
                            .connect(borrower)
                            .makePrincipalPayment(borrower.getAddress(), paymentAmount),
                    )
                        .to.emit(creditContract, "PrincipalPaymentMade")
                        .withArgs(
                            await borrower.getAddress(),
                            paymentAmountCollected,
                            nextDueDate.unix(),
                            BN.from(expectedNewCR.nextDue).sub(BN.from(expectedNewCR.yieldDue)),
                            expectedNewCR.unbilledPrincipal,
                            principalDuePaid,
                            unbilledPrincipalPaid,
                            await borrower.getAddress(),
                        );
                } else {
                    await expect(
                        creditContract
                            .connect(borrower)
                            .makePrincipalPayment(borrower.getAddress(), paymentAmount),
                    ).not.to.emit(creditContract, "PrincipalPaymentMade");
                }
                const borrowerBalanceAfter = await mockTokenContract.balanceOf(
                    borrower.getAddress(),
                );
                expect(borrowerBalanceBefore.sub(borrowerBalanceAfter)).to.equal(
                    paymentAmountCollected,
                );
                const poolSafeBalanceAfter = await mockTokenContract.balanceOf(
                    poolSafeContract.address,
                );
                expect(poolSafeBalanceAfter.sub(poolSafeBalanceBefore)).to.equal(
                    paymentAmountCollected,
                );

                const newCR = await creditContract.getCreditRecord(creditHash);
                await checkCreditRecordsMatch(newCR, expectedNewCR);

                const newDD = await creditContract.getDueDetail(creditHash);
                await checkDueDetailsMatch(newDD, expectedNewDD);
            }

            describe("When principal rate is zero", function () {
                async function prepareForMakePayment() {
                    principalRateInBps = 0;
                    await poolConfigContract.connect(poolOwner).setFeeStructure({
                        yieldInBps,
                        minPrincipalRateInBps: principalRateInBps,
                        lateFeeFlat,
                        lateFeeBps,
                        membershipFee,
                    });
                    await approveCredit();
                    await drawdown();
                }

                beforeEach(async function () {
                    await loadFixture(prepareForMakePayment);
                });

                it("Should allow the borrower to pay for the unbilled principal once in the current billing cycle", async function () {
                    const cr = await creditContract.getCreditRecord(creditHash);
                    const dd = await creditContract.getDueDetail(creditHash);

                    makePaymentDate = moment.utc({
                        year: nextYear,
                        month: 2,
                        day: 3,
                        hour: 5,
                        minute: 33,
                        second: 26,
                    });
                    const nextDueDate = firstDueDate;
                    const expectedNewCR = {
                        unbilledPrincipal: 0,
                        nextDueDate: nextDueDate.unix(),
                        nextDue: cr.nextDue,
                        yieldDue: cr.yieldDue,
                        totalPastDue: BN.from(0),
                        missedPeriods: 0,
                        remainingPeriods: cr.remainingPeriods,
                        state: CreditState.GoodStanding,
                    };
                    const expectedNewDD = {
                        lateFeeUpdatedDate: BN.from(0),
                        lateFee: BN.from(0),
                        principalPastDue: BN.from(0),
                        yieldPastDue: BN.from(0),
                        committed: dd.committed,
                        accrued: dd.accrued,
                        paid: BN.from(0),
                    };
                    await testMakePrincipalPayment(
                        makePaymentDate,
                        borrowAmount,
                        borrowAmount,
                        nextDueDate,
                        BN.from(0),
                        borrowAmount,
                        expectedNewCR,
                        expectedNewDD,
                    );
                });

                it("Should allow the borrower to make multiple payments for the unbilled principal within the same period", async function () {
                    const cc = await creditContract.getCreditConfig(creditHash);
                    const cr = await creditContract.getCreditRecord(creditHash);
                    const dd = await creditContract.getDueDetail(creditHash);
                    const maturityDate = moment.utc(
                        (await creditContract.maturityDates(creditHash)).toNumber() * 1000,
                    );

                    makePaymentDate = moment.utc({
                        year: nextYear,
                        month: 2,
                        day: 3,
                        hour: 5,
                        minute: 33,
                        second: 26,
                    });
                    const nextDueDate = firstDueDate;
                    const firstPaymentAmount = toToken(20_000);
                    let expectedNewCR = {
                        unbilledPrincipal: borrowAmount.sub(firstPaymentAmount),
                        nextDueDate: nextDueDate.unix(),
                        nextDue: cr.nextDue,
                        yieldDue: cr.yieldDue,
                        totalPastDue: BN.from(0),
                        missedPeriods: 0,
                        remainingPeriods: cr.remainingPeriods,
                        state: CreditState.GoodStanding,
                    };
                    await testMakePrincipalPayment(
                        makePaymentDate,
                        firstPaymentAmount,
                        firstPaymentAmount,
                        firstDueDate,
                        BN.from(0),
                        firstPaymentAmount,
                        expectedNewCR,
                        dd,
                    );

                    // Second payment pays off the unbilled principal.
                    const secondPaymentDate = moment.utc({
                        year: nextYear,
                        month: 2,
                        day: 4,
                        hour: 7,
                        minute: 5,
                        second: 56,
                    });
                    const secondPaymentAmount = borrowAmount.sub(toToken(20_000));
                    expectedNewCR = {
                        unbilledPrincipal: BN.from(0),
                        nextDueDate: nextDueDate.unix(),
                        nextDue: cr.nextDue,
                        yieldDue: cr.yieldDue,
                        totalPastDue: BN.from(0),
                        missedPeriods: 0,
                        remainingPeriods: cr.remainingPeriods,
                        state: CreditState.GoodStanding,
                    };
                    await testMakePrincipalPayment(
                        secondPaymentDate,
                        secondPaymentAmount,
                        secondPaymentAmount,
                        nextDueDate,
                        BN.from(0),
                        secondPaymentAmount,
                        expectedNewCR,
                        dd,
                    );

                    // Third payment is a no-op since the principal has already been paid off.
                    const thirdPaymentDate = moment.utc({
                        year: nextYear,
                        month: 2,
                        day: 4,
                        hour: 20,
                        minute: 8,
                    });
                    const thirdPaymentAmount = toToken(10_000);
                    await testMakePrincipalPayment(
                        thirdPaymentDate,
                        thirdPaymentAmount,
                        BN.from(0),
                        nextDueDate,
                        BN.from(0),
                        BN.from(0),
                        expectedNewCR,
                        dd,
                    );
                });

                it("Should allow the borrower to payoff the unbilled principal in the last period and close the credit line", async function () {
                    const cc = await creditContract.getCreditConfig(creditHash);
                    const cr = await creditContract.getCreditRecord(creditHash);
                    const dd = await creditContract.getDueDetail(creditHash);
                    const maturityDate = moment.utc(
                        (await creditContract.maturityDates(creditHash)).toNumber() * 1000,
                    );

                    // First payment pays off everything except the unbilled principal.
                    makePaymentDate = moment.utc({
                        year: nextYear,
                        month: 7,
                        day: 3,
                        hour: 9,
                        minute: 27,
                        second: 31,
                    });
                    const [
                        yieldPastDue,
                        yieldNextDue,
                        [accruedYieldNextDue, committedYieldNextDue],
                    ] = await calcYieldDueNew(
                        calendarContract,
                        cc,
                        cr,
                        dd,
                        makePaymentDate,
                        maturityDate,
                        latePaymentGracePeriodInDays,
                        membershipFee,
                    );
                    const [, lateFee] = await calcLateFeeNew(
                        poolConfigContract,
                        calendarContract,
                        cc,
                        cr,
                        dd,
                        makePaymentDate,
                        latePaymentGracePeriodInDays,
                    );
                    await setNextBlockTimestamp(makePaymentDate.unix());
                    await creditContract
                        .connect(borrower)
                        .makePayment(
                            borrower.getAddress(),
                            yieldPastDue.add(yieldNextDue).add(lateFee),
                        );

                    // Second payment pays off the unbilled principal.
                    const secondPaymentDate = moment.utc({
                        year: nextYear,
                        month: 7,
                        day: 4,
                        hour: 17,
                        minute: 16,
                    });
                    const nextDueDate = maturityDate;
                    const expectedNewCR = {
                        unbilledPrincipal: BN.from(0),
                        nextDueDate: nextDueDate.unix(),
                        nextDue: BN.from(0),
                        yieldDue: BN.from(0),
                        totalPastDue: BN.from(0),
                        missedPeriods: 0,
                        remainingPeriods: 0,
                        state: CreditState.Deleted,
                    };
                    const expectedNewDD = {
                        lateFeeUpdatedDate: 0,
                        lateFee: BN.from(0),
                        principalPastDue: BN.from(0),
                        yieldPastDue: BN.from(0),
                        committed: committedYieldNextDue,
                        accrued: accruedYieldNextDue,
                        paid: yieldNextDue,
                    };
                    await testMakePrincipalPayment(
                        secondPaymentDate,
                        borrowAmount,
                        borrowAmount,
                        nextDueDate,
                        BN.from(0),
                        borrowAmount,
                        expectedNewCR,
                        expectedNewDD,
                    );

                    // Any further attempt to make principal payment will be rejected since the
                    // credit line is closed.
                    await expect(
                        creditContract
                            .connect(borrower)
                            .makePrincipalPayment(borrower.getAddress(), toToken(1)),
                    ).to.be.revertedWithCustomError(
                        creditContract,
                        "creditLineNotInStateForMakingPrincipalPayment",
                    );
                });

                it("Should not allow payment when the protocol is paused or pool is not on", async function () {
                    await humaConfigContract.connect(protocolOwner).pause();
                    await expect(
                        creditContract.makePrincipalPayment(borrower.getAddress(), toToken(1)),
                    ).to.be.revertedWithCustomError(poolConfigContract, "protocolIsPaused");
                    await humaConfigContract.connect(protocolOwner).unpause();

                    await poolContract.connect(poolOwner).disablePool();
                    await expect(
                        creditContract.makePrincipalPayment(borrower.getAddress(), toToken(1)),
                    ).to.be.revertedWithCustomError(poolConfigContract, "poolIsNotOn");
                    await poolContract.connect(poolOwner).enablePool();
                });

                it("Should not allow non-borrower or non-PDS service account to make principal payment", async function () {
                    await expect(
                        creditContract
                            .connect(borrower2)
                            .makePrincipalPayment(borrower.getAddress(), toToken(1)),
                    ).to.be.revertedWithCustomError(
                        creditContract,
                        "paymentDetectionServiceAccountRequired",
                    );
                });

                it("Should not allow the borrower to make principal payment with 0 amount", async function () {
                    await expect(
                        creditContract
                            .connect(borrower)
                            .makePrincipalPayment(borrower.getAddress(), 0),
                    ).to.be.revertedWithCustomError(creditContract, "zeroAmountProvided");
                });

                it("Should not allow the borrower to pay for the principal if the bill is not in good standing state", async function () {
                    makePaymentDate = moment.utc({
                        year: nextYear,
                        month: 2,
                        day: 28,
                        hour: 4,
                        minute: 48,
                        second: 31,
                    });
                    await setNextBlockTimestamp(makePaymentDate.unix());
                    await expect(
                        creditContract
                            .connect(borrower)
                            .makePrincipalPayment(borrower.getAddress(), toToken(1)),
                    ).to.be.revertedWithCustomError(
                        creditContract,
                        "creditLineNotInStateForMakingPrincipalPayment",
                    );
                });
            });

            describe("When principal rate is non-zero", function () {
                async function prepareForMakePayment() {
                    principalRateInBps = 200;
                    await poolConfigContract.connect(poolOwner).setFeeStructure({
                        yieldInBps,
                        minPrincipalRateInBps: principalRateInBps,
                        lateFeeFlat,
                        lateFeeBps,
                        membershipFee,
                    });
                    await approveCredit();
                    await drawdown();
                }

                beforeEach(async function () {
                    await loadFixture(prepareForMakePayment);
                });

                it("Should allow the borrower to pay for all principal once in the current billing cycle", async function () {
                    const cc = await creditContract.getCreditConfig(creditHash);
                    const cr = await creditContract.getCreditRecord(creditHash);
                    const dd = await creditContract.getDueDetail(creditHash);
                    const maturityDate = moment.utc(
                        (await creditContract.maturityDates(creditHash)).toNumber() * 1000,
                    );

                    makePaymentDate = moment.utc({
                        year: nextYear,
                        month: 2,
                        day: 3,
                        hour: 5,
                        minute: 33,
                        second: 26,
                    });
                    const nextDueDate = firstDueDate;
                    const [, , principalNextDue] = await calcPrincipalDueNew(
                        calendarContract,
                        cc,
                        cr,
                        dd,
                        makePaymentDate,
                        maturityDate,
                        latePaymentGracePeriodInDays,
                        principalRateInBps,
                    );
                    const expectedNewCR = {
                        unbilledPrincipal: BN.from(0),
                        nextDueDate: nextDueDate.unix(),
                        nextDue: cr.nextDue.sub(principalNextDue),
                        yieldDue: cr.yieldDue,
                        totalPastDue: BN.from(0),
                        missedPeriods: 0,
                        remainingPeriods: cr.remainingPeriods,
                        state: CreditState.GoodStanding,
                    };
                    await testMakePrincipalPayment(
                        makePaymentDate,
                        borrowAmount,
                        borrowAmount,
                        nextDueDate,
                        principalNextDue,
                        borrowAmount.sub(principalNextDue),
                        expectedNewCR,
                        dd,
                    );
                });

                it("Should allow the borrower to make multiple principal payments within the same period", async function () {
                    const cc = await creditContract.getCreditConfig(creditHash);
                    const cr = await creditContract.getCreditRecord(creditHash);
                    const dd = await creditContract.getDueDetail(creditHash);
                    const maturityDate = moment.utc(
                        (await creditContract.maturityDates(creditHash)).toNumber() * 1000,
                    );

                    // First payment pays off principal next due in the current billing cycle.
                    makePaymentDate = moment.utc({
                        year: nextYear,
                        month: 2,
                        day: 3,
                        hour: 5,
                        minute: 33,
                        second: 26,
                    });
                    const nextDueDate = firstDueDate;
                    const [unbilledPrincipal, , principalNextDue] = await calcPrincipalDueNew(
                        calendarContract,
                        cc,
                        cr,
                        dd,
                        makePaymentDate,
                        maturityDate,
                        latePaymentGracePeriodInDays,
                        principalRateInBps,
                    );
                    const firstPaymentAmount = principalNextDue;
                    let expectedNewCR = {
                        unbilledPrincipal: cr.unbilledPrincipal,
                        nextDueDate: nextDueDate.unix(),
                        nextDue: cr.nextDue.sub(principalNextDue),
                        yieldDue: cr.yieldDue,
                        totalPastDue: BN.from(0),
                        missedPeriods: 0,
                        remainingPeriods: cr.remainingPeriods,
                        state: CreditState.GoodStanding,
                    };
                    await testMakePrincipalPayment(
                        makePaymentDate,
                        firstPaymentAmount,
                        firstPaymentAmount,
                        firstDueDate,
                        principalNextDue,
                        BN.from(0),
                        expectedNewCR,
                        dd,
                    );

                    // Second payment pays off the unbilled principal.
                    const secondPaymentDate = moment.utc({
                        year: nextYear,
                        month: 2,
                        day: 5,
                        hour: 20,
                        minute: 8,
                    });
                    // Attempt to pay the entire borrow amount, but only unbilled principal should be charged.
                    const secondPaymentAmount = borrowAmount;
                    expectedNewCR = {
                        unbilledPrincipal: BN.from(0),
                        nextDueDate: nextDueDate.unix(),
                        nextDue: cr.nextDue.sub(principalNextDue),
                        yieldDue: cr.yieldDue,
                        totalPastDue: BN.from(0),
                        missedPeriods: 0,
                        remainingPeriods: cr.remainingPeriods,
                        state: CreditState.GoodStanding,
                    };
                    await testMakePrincipalPayment(
                        secondPaymentDate,
                        secondPaymentAmount,
                        unbilledPrincipal,
                        nextDueDate,
                        BN.from(0),
                        unbilledPrincipal,
                        expectedNewCR,
                        dd,
                    );
                });

                it("Should allow the borrower to payoff the principal in the last period and close the credit line", async function () {
                    const cc = await creditContract.getCreditConfig(creditHash);
                    let cr = await creditContract.getCreditRecord(creditHash);
                    let dd = await creditContract.getDueDetail(creditHash);
                    const maturityDate = moment.utc(
                        (await creditContract.maturityDates(creditHash)).toNumber() * 1000,
                    );

                    // First payment pays off the all past due and next due.
                    makePaymentDate = moment.utc({
                        year: nextYear,
                        month: 7,
                        day: 3,
                        hour: 9,
                        minute: 27,
                        second: 31,
                    });
                    const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                        calendarContract,
                        cc,
                        cr,
                        dd,
                        makePaymentDate,
                        maturityDate,
                        latePaymentGracePeriodInDays,
                        membershipFee,
                    );
                    let [unbilledPrincipal, principalPastDue, principalNextDue] =
                        await calcPrincipalDueNew(
                            calendarContract,
                            cc,
                            cr,
                            dd,
                            makePaymentDate,
                            maturityDate,
                            latePaymentGracePeriodInDays,
                            principalRateInBps,
                        );
                    const [, lateFee] = await calcLateFeeNew(
                        poolConfigContract,
                        calendarContract,
                        cc,
                        cr,
                        dd,
                        makePaymentDate,
                        latePaymentGracePeriodInDays,
                    );
                    await setNextBlockTimestamp(makePaymentDate.unix());
                    await creditContract
                        .connect(borrower)
                        .makePayment(
                            borrower.getAddress(),
                            yieldPastDue
                                .add(principalPastDue)
                                .add(lateFee)
                                .add(yieldNextDue)
                                .add(principalNextDue),
                        );

                    // Second payment pays off the principal due and closes the credit line.
                    const secondPaymentDate = moment.utc({
                        year: nextYear,
                        month: 7,
                        day: 4,
                        hour: 17,
                        minute: 16,
                    });
                    const nextDueDate = maturityDate;
                    const secondPaymentAmount = unbilledPrincipal;
                    dd = await creditContract.getDueDetail(creditHash);
                    let expectedNewCR = {
                        unbilledPrincipal: BN.from(0),
                        nextDueDate: nextDueDate.unix(),
                        nextDue: BN.from(0),
                        yieldDue: BN.from(0),
                        totalPastDue: BN.from(0),
                        missedPeriods: 0,
                        remainingPeriods: 0,
                        state: CreditState.Deleted,
                    };
                    await testMakePrincipalPayment(
                        secondPaymentDate,
                        secondPaymentAmount,
                        secondPaymentAmount,
                        nextDueDate,
                        BN.from(0),
                        unbilledPrincipal,
                        expectedNewCR,
                        dd,
                    );
                    // Further payment attempts will be rejected.
                    await expect(
                        creditContract
                            .connect(borrower)
                            .makePrincipalPayment(borrower.getAddress(), toToken(1)),
                    ).to.be.revertedWithCustomError(
                        creditContract,
                        "creditLineNotInStateForMakingPrincipalPayment",
                    );
                });

                it("Should not allow the borrower to pay for the principal if the bill is not in good standing state", async function () {
                    makePaymentDate = moment.utc({
                        year: nextYear,
                        month: 2,
                        day: 28,
                        hour: 4,
                        minute: 48,
                        second: 31,
                    });
                    await setNextBlockTimestamp(makePaymentDate.unix());
                    await expect(
                        creditContract
                            .connect(borrower)
                            .makePrincipalPayment(borrower.getAddress(), toToken(1)),
                    ).to.be.revertedWithCustomError(
                        creditContract,
                        "creditLineNotInStateForMakingPrincipalPayment",
                    );
                });
            });
        });
    });

    // describe("RefreshCredit Tests", function () {
    //     const yieldInBps = 1217;
    //     const frontLoadingFeeBps = 100;
    //     const periodDuration = 2;
    //     let borrowAmount: BN, creditHash: string, borrowAmount2: BN, creditHash2: string;
    //
    //     async function prepareForRefreshCredit() {
    //         await poolConfigContract.connect(poolOwner).setFrontLoadingFees({
    //             frontLoadingFeeFlat: 0,
    //             frontLoadingFeeBps: frontLoadingFeeBps,
    //         });
    //
    //         await poolConfigContract.connect(poolOwner).setPoolPayPeriod(periodDuration);
    //
    //         await poolConfigContract
    //             .connect(poolOwner)
    //             .setPoolDefaultGracePeriod(periodDuration * 3);
    //
    //         let juniorDepositAmount = toToken(300_000);
    //         await juniorTrancheVaultContract
    //             .connect(lender)
    //             .deposit(juniorDepositAmount, lender.address);
    //         let seniorDepositAmount = toToken(100_000);
    //         await seniorTrancheVaultContract
    //             .connect(lender)
    //             .deposit(seniorDepositAmount, lender.address);
    //
    //         // The borrower needs to make additional first loss cover deposits in order to
    //         // cover for the new funds made by the lenders.
    //         await borrowerFirstLossCoverContract
    //             .connect(borrower)
    //             .depositCover(
    //                 await getMinFirstLossCoverRequirement(
    //                     borrowerFirstLossCoverContract,
    //                     poolConfigContract,
    //                     poolContract,
    //                     borrower.address,
    //                 ),
    //             );
    //
    //         await creditContract
    //             .connect(eaServiceAccount)
    //             .approveBorrower(
    //                 borrower.address,
    //                 toToken(100_000),
    //                 5,
    //                 yieldInBps,
    //                 toToken(100_000),
    //                 true,
    //             );
    //
    //         borrowAmount = toToken(10_000);
    //         await creditContract.connect(borrower).drawdown(borrower.address, borrowAmount);
    //
    //         creditHash = ethers.utils.keccak256(
    //             ethers.utils.defaultAbiCoder.encode(
    //                 ["address", "address"],
    //                 [creditContract.address, borrower.address],
    //             ),
    //         );
    //     }
    //
    //     beforeEach(async function () {
    //         await loadFixture(prepareForRefreshCredit);
    //     });
    //
    //     it("Should not create new due info before due date", async function () {
    //         let creditRecord = await creditContract.getCreditRecord(creditHash);
    //
    //         // move forward 10 days
    //         let nextTime = await getFutureBlockTime(CONSTANTS.SECONDS_IN_A_DAY * 10);
    //         await mineNextBlockWithTimestamp(nextTime);
    //
    //         let preCreditRecord = creditRecord;
    //         await creditContract.refreshCredit(borrower.address);
    //         creditRecord = await creditContract.getCreditRecord(creditHash);
    //         checkTwoCreditRecords(preCreditRecord, creditRecord);
    //     });
    //
    //     it("Should not create new due info after due date and before grace late date", async function () {
    //         let creditRecord = await creditContract.getCreditRecord(creditHash);
    //
    //         // move forward after due date and before grace late date
    //         let poolSettings = await poolConfigContract.getPoolSettings();
    //         let nextTime =
    //             creditRecord.nextDueDate.toNumber() +
    //             CONSTANTS.SECONDS_IN_A_DAY * (poolSettings.latePaymentGracePeriodInDays - 1);
    //         await mineNextBlockWithTimestamp(nextTime);
    //
    //         let preCreditRecord = creditRecord;
    //         await creditContract.refreshCredit(borrower.address);
    //         creditRecord = await creditContract.getCreditRecord(creditHash);
    //         checkTwoCreditRecords(preCreditRecord, creditRecord);
    //     });
    //
    //     it.skip("Should create new due info after grace late date", async function () {
    //         let creditRecord = await creditContract.getCreditRecord(creditHash);
    //
    //         // move forward after grace late date
    //         let poolSettings = await poolConfigContract.getPoolSettings();
    //         let nextTime =
    //             creditRecord.nextDueDate.toNumber() +
    //             CONSTANTS.SECONDS_IN_A_DAY * (poolSettings.latePaymentGracePeriodInDays + 1);
    //         await mineNextBlockWithTimestamp(nextTime);
    //
    //         let preCreditRecord = creditRecord;
    //         await creditContract.refreshCredit(borrower.address);
    //         creditRecord = await creditContract.getCreditRecord(creditHash);
    //         printCreditRecord(`preCreditRecord`, preCreditRecord);
    //         printCreditRecord(`creditRecord`, creditRecord);
    //
    //         let creditRecordSettings = await getCreditRecordSettings();
    //         let creditConfig = await creditContract.getCreditConfig(creditHash);
    //         let [newCreditRecord, principalDiff, missProfit] = calcLateCreditRecord(
    //             preCreditRecord,
    //             creditConfig,
    //             1,
    //             nextTime,
    //             creditRecordSettings,
    //         );
    //         printCreditRecord(`newCreditRecord`, newCreditRecord);
    //         checkTwoCreditRecords(creditRecord, newCreditRecord);
    //     });
    //
    //     it.skip("Should create new due info after multiple periods", async function () {
    //         let creditRecord = await creditContract.getCreditRecord(creditHash);
    //
    //         // move forward after grace late date
    //         let poolSettings = await poolConfigContract.getPoolSettings();
    //         let nextTime =
    //             getNextDueDate(
    //                 creditRecord.nextDueDate.toNumber(),
    //                 creditRecord.nextDueDate.toNumber(),
    //                 periodDuration,
    //             )[0] +
    //             60 * 10;
    //         await mineNextBlockWithTimestamp(nextTime);
    //         // console.log(`nextTime: ${nextTime}`);
    //
    //         let preCreditRecord = creditRecord;
    //         await creditContract.refreshCredit(borrower.address);
    //         creditRecord = await creditContract.getCreditRecord(creditHash);
    //         printCreditRecord(`preCreditRecord`, preCreditRecord);
    //         printCreditRecord(`creditRecord`, creditRecord);
    //
    //         let creditRecordSettings = await getCreditRecordSettings();
    //         let creditConfig = await creditContract.getCreditConfig(creditHash);
    //         let [newCreditRecord, principalDiff, missProfit] = calcLateCreditRecord(
    //             preCreditRecord,
    //             creditConfig,
    //             2,
    //             nextTime,
    //             creditRecordSettings,
    //         );
    //         printCreditRecord(`newCreditRecord`, newCreditRecord);
    //         checkTwoCreditRecords(creditRecord, newCreditRecord);
    //     });
    //
    //     it.skip("Should create new due info while credit state is delayed", async function () {
    //         let creditRecord = await creditContract.getCreditRecord(creditHash);
    //
    //         // move forward after grace late date
    //         let poolSettings = await poolConfigContract.getPoolSettings();
    //         let nextTime =
    //             creditRecord.nextDueDate.toNumber() +
    //             CONSTANTS.SECONDS_IN_A_DAY * (poolSettings.latePaymentGracePeriodInDays + 2);
    //         await mineNextBlockWithTimestamp(nextTime);
    //
    //         let preCreditRecord = creditRecord;
    //         await creditContract.refreshCredit(borrower.address);
    //         creditRecord = await creditContract.getCreditRecord(creditHash);
    //
    //         let creditRecordSettings = await getCreditRecordSettings();
    //         let creditConfig = await creditContract.getCreditConfig(creditHash);
    //         let [newCreditRecord, principalDiff, missProfit] = calcLateCreditRecord(
    //             preCreditRecord,
    //             creditConfig,
    //             1,
    //             nextTime,
    //             creditRecordSettings,
    //         );
    //         checkTwoCreditRecords(creditRecord, newCreditRecord);
    //         printCreditRecord(`preCreditRecord`, preCreditRecord);
    //         printCreditRecord(`creditRecord`, creditRecord);
    //
    //         let defaultDate = calcDefaultDate(
    //             preCreditRecord,
    //             poolSettings.defaultGracePeriodInMonths,
    //         );
    //         let lossStartDate = preCreditRecord.nextDueDate.toNumber();
    //         let lossStartPrincipal = getPrincipal(preCreditRecord);
    //
    //         nextTime =
    //             getNextDueDate(
    //                 preCreditRecord.nextDueDate.toNumber(),
    //                 preCreditRecord.nextDueDate.toNumber(),
    //                 2 * periodDuration,
    //             )[0] +
    //             60 * 10;
    //         await mineNextBlockWithTimestamp(nextTime);
    //
    //         preCreditRecord = creditRecord;
    //         await creditContract.refreshCredit(borrower.address);
    //         creditRecord = await creditContract.getCreditRecord(creditHash);
    //
    //         // console.log(`nextTime: ${nextTime}`);
    //         printCreditRecord(`preCreditRecord`, preCreditRecord);
    //         printCreditRecord(`creditRecord`, creditRecord);
    //
    //         [newCreditRecord, principalDiff, missProfit] = calcLateCreditRecord(
    //             preCreditRecord,
    //             creditConfig,
    //             2,
    //             nextTime,
    //             creditRecordSettings,
    //         );
    //         checkTwoCreditRecords(creditRecord, newCreditRecord);
    //     });
    //
    //     it.skip("Should become defaulted after default grace periods", async function () {
    //         //* todo add CreditLoss expects
    //
    //         let creditRecord = await creditContract.getCreditRecord(creditHash);
    //
    //         // move forward after grace late date
    //         let poolSettings = await poolConfigContract.getPoolSettings();
    //         let nextTime =
    //             creditRecord.nextDueDate.toNumber() +
    //             CONSTANTS.SECONDS_IN_A_DAY * (poolSettings.latePaymentGracePeriodInDays + 1);
    //         await mineNextBlockWithTimestamp(nextTime);
    //
    //         let preCreditRecord = creditRecord;
    //         await creditContract.refreshCredit(borrower.address);
    //         creditRecord = await creditContract.getCreditRecord(creditHash);
    //
    //         let creditRecordSettings = await getCreditRecordSettings();
    //         let creditConfig = await creditContract.getCreditConfig(creditHash);
    //         let [newCreditRecord, principalDiff, missProfit] = calcLateCreditRecord(
    //             preCreditRecord,
    //             creditConfig,
    //             1,
    //             nextTime,
    //             creditRecordSettings,
    //         );
    //         // printCreditRecord(`preCreditRecord`, preCreditRecord);
    //         // printCreditRecord(`creditRecord`, creditRecord);
    //         checkTwoCreditRecords(creditRecord, newCreditRecord);
    //
    //         let defaultDate = calcDefaultDate(
    //             preCreditRecord,
    //             poolSettings.defaultGracePeriodInMonths,
    //         );
    //         let lossStartDate = preCreditRecord.nextDueDate.toNumber();
    //         let lossStartPrincipal = getPrincipal(preCreditRecord);
    //
    //         // console.log(`creditLoss: ${creditLoss}`);
    //
    //         let accruedLoss = getPrincipal(creditRecord)
    //             .sub(lossStartPrincipal)
    //             .add(
    //                 calcYield(
    //                     getPrincipal(creditRecord),
    //                     yieldInBps,
    //                     nextTime -
    //                         getStartDateOfPeriod(
    //                             periodDuration,
    //                             creditRecord.nextDueDate.toNumber(),
    //                         ),
    //                 ),
    //             );
    //         // console.log(`accruedLoss: ${accruedLoss}, lossRate: ${lossRate}`);
    //
    //         nextTime =
    //             getNextDueDate(
    //                 preCreditRecord.nextDueDate.toNumber(),
    //                 preCreditRecord.nextDueDate.toNumber(),
    //                 3 * periodDuration,
    //             )[0] +
    //             60 * 5;
    //         await mineNextBlockWithTimestamp(nextTime);
    //
    //         preCreditRecord = creditRecord;
    //         await creditContract.refreshCredit(borrower.address);
    //         creditRecord = await creditContract.getCreditRecord(creditHash);
    //
    //         // console.log(`nextTime: ${nextTime}`);
    //         printCreditRecord(`preCreditRecord`, preCreditRecord);
    //         printCreditRecord(`creditRecord`, creditRecord);
    //
    //         [newCreditRecord, principalDiff, missProfit] = calcLateCreditRecord(
    //             preCreditRecord,
    //             creditConfig,
    //             3,
    //             nextTime,
    //             creditRecordSettings,
    //         );
    //         newCreditRecord.state = 5;
    //         checkTwoCreditRecords(creditRecord, newCreditRecord);
    //
    //         // credit doesn't change after default
    //
    //         preCreditRecord = creditRecord;
    //         await creditContract.refreshCredit(borrower.address);
    //         creditRecord = await creditContract.getCreditRecord(creditHash);
    //         checkTwoCreditRecords(creditRecord, newCreditRecord);
    //     });
    //
    //     it("Should refresh credit correctly with multiple credits, while setting late fee, membership fee and minPrincipalRateInBps", async function () {
    //         //* todo fix this test
    //
    //         let creditRecord = await creditContract.getCreditRecord(creditHash);
    //
    //         // printCreditRecord(`creditRecord`, creditRecord);
    //         // let profitRate = calcProfitRateWithCR(creditRecord, yieldInBps);
    //         // let accruedProfit = borrowAmount.mul(frontLoadingFeeBps).div(CONSTANTS.BP_FACTOR);
    //         // let block = await getLatestBlock();
    //         // // console.log(`accruedProfit: ${accruedProfit}`);
    //         // let pnlTracker = await creditPnlManagerContract.getPnL();
    //         // // console.log(`pnlTracker: ${pnlTracker}`);
    //         // checkPnLTracker(
    //         //     pnlTracker,
    //         //     profitRate,
    //         //     block.timestamp,
    //         //     accruedProfit,
    //         //     BN.from(0),
    //         //     BN.from(0),
    //         // );
    //         // let preTime = block.timestamp;
    //         // let lateFeeBps = 200;
    //         // let membershipFee = toToken(100);
    //         // let minPrincipalRateInBps = 1000;
    //         // await poolConfigContract.connect(poolOwner).setFeeStructure({
    //         //     yieldInBps: yieldInBps,
    //         //     minPrincipalRateInBps: minPrincipalRateInBps,
    //         //     lateFeeFlat: BN.from(0),
    //         //     lateFeeBps: lateFeeBps,
    //         //     membershipFee: membershipFee,
    //         // });
    //         // await creditContract
    //         //     .connect(eaServiceAccount)
    //         //     .approveBorrower(
    //         //         borrower2.address,
    //         //         toToken(100_000),
    //         //         5,
    //         //         yieldInBps,
    //         //         toToken(100_000),
    //         //         true,
    //         //     );
    //         // // Make sure borrower2 has enough first loss cover.
    //         // await borrowerFirstLossCoverContract
    //         //     .connect(borrower2)
    //         //     .depositCover(
    //         //         await getMinFirstLossCoverRequirement(
    //         //             borrowerFirstLossCoverContract,
    //         //             poolConfigContract,
    //         //             poolContract,
    //         //             borrower2.address,
    //         //         ),
    //         //     );
    //         // // move forward 30 days for borrower2 drawdown
    //         // block = await getLatestBlock();
    //         // let nextTime = timestampToMoment(block.timestamp).add(1, "months").unix();
    //         // // console.log(`nextTime: ${nextTime}`);
    //         // await mineNextBlockWithTimestamp(nextTime);
    //         // borrowAmount2 = toToken(15_000);
    //         // await creditContract.connect(borrower2).drawdown(borrower2.address, borrowAmount2);
    //         // creditHash2 = ethers.utils.keccak256(
    //         //     ethers.utils.defaultAbiCoder.encode(
    //         //         ["address", "address"],
    //         //         [creditContract.address, borrower2.address],
    //         //     ),
    //         // );
    //         // accruedProfit = accruedProfit.add(
    //         //     BN.from(nextTime - preTime)
    //         //         .mul(profitRate)
    //         //         .div(CONSTANTS.DEFAULT_DECIMALS_FACTOR),
    //         // );
    //         // let accruedProfit2 = borrowAmount2.mul(frontLoadingFeeBps).div(CONSTANTS.BP_FACTOR);
    //         // let creditRecord2 = await creditContract.getCreditRecord(creditHash2);
    //         // let profitRate2 = calcProfitRateWithCR(creditRecord2, yieldInBps);
    //         // pnlTracker = await creditPnlManagerContract.getPnL();
    //         // // console.log(`pnlTracker: ${pnlTracker}`);
    //         // checkPnLTracker(
    //         //     pnlTracker,
    //         //     profitRate.add(profitRate2),
    //         //     nextTime,
    //         //     accruedProfit.add(accruedProfit2),
    //         //     BN.from(0),
    //         //     BN.from(0),
    //         //     2,
    //         // );
    //         // preTime = nextTime;
    //         // // refresh browser credit and its state becomes delayed
    //         // let poolSettings = await poolConfigContract.getPoolSettings();
    //         // let creditRecordSettings = await getCreditRecordSettings();
    //         // let creditConfig = await creditContract.getCreditConfig(creditHash);
    //         // creditRecord = await creditContract.getCreditRecord(creditHash);
    //         // nextTime =
    //         //     creditRecord.nextDueDate.toNumber() +
    //         //     CONSTANTS.SECONDS_IN_A_DAY * poolSettings.latePaymentGracePeriodInDays +
    //         //     60 * 10;
    //         // // printCreditRecord(`creditRecord`, creditRecord);
    //         // // console.log(`nextTime: ${nextTime}`);
    //         // await mineNextBlockWithTimestamp(nextTime);
    //         // let preCreditRecord = creditRecord;
    //         // await creditContract.refreshCredit(borrower.address);
    //         // creditRecord = await creditContract.getCreditRecord(creditHash);
    //         // let [newCreditRecord, ,] = calcLateCreditRecord(
    //         //     preCreditRecord,
    //         //     creditConfig,
    //         //     1,
    //         //     nextTime,
    //         //     creditRecordSettings,
    //         // );
    //         // // printCreditRecord(`newCreditRecord`, newCreditRecord);
    //         // checkTwoCreditRecords(creditRecord, newCreditRecord);
    //         // profitRate = calcProfitRateWithCR(creditRecord, yieldInBps);
    //         // let defaultDate = calcDefaultDate(
    //         //     preCreditRecord,
    //         //     poolSettings.defaultGracePeriodInMonths,
    //         // );
    //         // accruedProfit = preCreditRecord.yieldDue
    //         //     .add(
    //         //         calcYield(
    //         //             getPrincipal(creditRecord),
    //         //             yieldInBps,
    //         //             nextTime - preCreditRecord.nextDueDate.toNumber(),
    //         //         ),
    //         //     )
    //         //     .add(borrowAmount.mul(frontLoadingFeeBps).div(CONSTANTS.BP_FACTOR));
    //         // accruedProfit2 = BN.from(
    //         //     borrowAmount2.mul(frontLoadingFeeBps).div(CONSTANTS.BP_FACTOR),
    //         // ).add(calcYield(getPrincipal(creditRecord2), yieldInBps, nextTime - preTime));
    //         // let accruedLoss = getPrincipal(creditRecord)
    //         //     .sub(getPrincipal(preCreditRecord))
    //         //     .add(
    //         //         calcYield(
    //         //             getPrincipal(creditRecord),
    //         //             yieldInBps,
    //         //             nextTime -
    //         //                 getStartDateOfPeriod(
    //         //                     CONSTANTS.CALENDAR_UNIT_MONTH,
    //         //                     periodDuration,
    //         //                     creditRecord.nextDueDate.toNumber(),
    //         //                 ),
    //         //         ),
    //         //     );
    //         // pnlTracker = await creditPnlManagerContract.getPnL();
    //         // // console.log(`pnlTracker: ${pnlTracker}`);
    //         // checkPnLTracker(
    //         //     pnlTracker,
    //         //     profitRate.add(profitRate2),
    //         //     nextTime,
    //         //     accruedProfit.add(accruedProfit2),
    //         //     BN.from(0),
    //         //     BN.from(0),
    //         //     2,
    //         // );
    //         // let creditLoss = await creditPnlManagerContract.getCreditLoss(creditHash);
    //         // // console.log(`creditLoss: ${creditLoss}`);
    //         // checkCreditLoss(creditLoss, accruedLoss, BN.from(0), 1);
    //         // // refresh browser2 credit and its state becomes delayed
    //         // creditRecord2 = await creditContract.getCreditRecord(creditHash2);
    //         // preTime = nextTime;
    //         // nextTime =
    //         //     creditRecord2.nextDueDate.toNumber() +
    //         //     CONSTANTS.SECONDS_IN_A_DAY * poolSettings.latePaymentGracePeriodInDays +
    //         //     60 * 5;
    //         // printCreditRecord(`creditRecord2`, creditRecord2);
    //         // console.log(`nextTime: ${nextTime}`);
    //         // await mineNextBlockWithTimestamp(nextTime);
    //         // let preCreditRecord2 = creditRecord2;
    //         // await creditContract.refreshCredit(borrower2.address);
    //         // creditRecord2 = await creditContract.getCreditRecord(creditHash2);
    //         // printCreditRecord(`creditRecord2`, creditRecord2);
    //         // let [newCreditRecord2, ,] = calcLateCreditRecord(
    //         //     preCreditRecord2,
    //         //     creditConfig,
    //         //     1,
    //         //     nextTime,
    //         //     creditRecordSettings,
    //         // );
    //         // // printCreditRecord(`newCreditRecord`, newCreditRecord);
    //         // checkTwoCreditRecords(creditRecord2, newCreditRecord2);
    //         // profitRate2 = calcProfitRateWithCR(creditRecord2, yieldInBps);
    //         // let defaultDate2 = calcDefaultDate(
    //         //     preCreditRecord2,
    //         //     poolSettings.defaultGracePeriodInMonths,
    //         // );
    //         // accruedProfit2 = BN.from(
    //         //     borrowAmount2.mul(frontLoadingFeeBps).div(CONSTANTS.BP_FACTOR),
    //         // )
    //         //     .add(getPrincipal(creditRecord2).sub(borrowAmount2))
    //         //     .add(
    //         //         calcYield(
    //         //             getPrincipal(creditRecord2),
    //         //             yieldInBps,
    //         //             nextTime - preCreditRecord2.nextDueDate.toNumber(),
    //         //         ),
    //         //     );
    //         // accruedProfit = accruedProfit.add(
    //         //     calcYield(getPrincipal(creditRecord), yieldInBps, nextTime - preTime),
    //         // );
    //         // let accruedLoss2 = getPrincipal(creditRecord2)
    //         //     .sub(getPrincipal(preCreditRecord2))
    //         //     .add(
    //         //         calcYield(
    //         //             getPrincipal(creditRecord2),
    //         //             yieldInBps,
    //         //             nextTime -
    //         //                 getStartDateOfPeriod(
    //         //                     CONSTANTS.CALENDAR_UNIT_MONTH,
    //         //                     periodDuration,
    //         //                     creditRecord2.nextDueDate.toNumber(),
    //         //                 ),
    //         //         ),
    //         //     );
    //         // // console.log(
    //         // //     `profitRate.add(profitRate2): ${profitRate.add(
    //         // //         profitRate2,
    //         // //     )}, lossRate.add(lossRate2): ${lossRate.add(
    //         // //         lossRate2,
    //         // //     )}, accruedProfit.add(accruedProfit2): ${accruedProfit.add(
    //         // //         accruedProfit2,
    //         // //     )}, accruedLoss.add(accruedLoss2): ${accruedLoss.add(accruedLoss2)}`,
    //         // // );
    //         // pnlTracker = await creditPnlManagerContract.getPnL();
    //         // // console.log(`pnlTracker: ${pnlTracker}`);
    //         // checkPnLTracker(
    //         //     pnlTracker,
    //         //     profitRate.add(profitRate2),
    //         //     nextTime,
    //         //     accruedProfit.add(accruedProfit2),
    //         //     accruedLoss.add(accruedLoss2),
    //         //     BN.from(0),
    //         //     2,
    //         // );
    //         // let creditLoss2 = await creditPnlManagerContract.getCreditLoss(creditHash2);
    //         // // console.log(`creditLoss: ${creditLoss}`);
    //         // checkCreditLoss(creditLoss2, accruedLoss2, BN.from(0), 1);
    //         // // move forward, refresh browser credit and its state becomes defaulted
    //         // preTime = nextTime;
    //         // nextTime =
    //         //     getNextMonth(
    //         //         preCreditRecord.nextDueDate.toNumber(),
    //         //         preCreditRecord.nextDueDate.toNumber(),
    //         //         3 * periodDuration,
    //         //     )[0] +
    //         //     60 * 5;
    //         // await mineNextBlockWithTimestamp(nextTime);
    //         // preCreditRecord = creditRecord;
    //         // await creditContract.refreshCredit(borrower.address);
    //         // creditRecord = await creditContract.getCreditRecord(creditHash);
    //         // printCreditRecord(`creditRecord`, creditRecord);
    //         // [newCreditRecord, ,] = calcLateCreditRecord(
    //         //     preCreditRecord,
    //         //     creditConfig,
    //         //     3,
    //         //     nextTime,
    //         //     creditRecordSettings,
    //         // );
    //         // newCreditRecord.state = 6;
    //         // checkTwoCreditRecords(creditRecord, newCreditRecord);
    //         // accruedProfit = BN.from(
    //         //     borrowAmount.mul(frontLoadingFeeBps).div(CONSTANTS.BP_FACTOR),
    //         // ).add(getPrincipal(creditRecord).sub(borrowAmount));
    //         // accruedProfit2 = accruedProfit2.add(
    //         //     profitRate2.mul(nextTime - preTime).div(CONSTANTS.DEFAULT_DECIMALS_FACTOR),
    //         // );
    //         // accruedLoss = getPrincipal(creditRecord);
    //         // // console.log(
    //         // //     `profitRate.add(profitRate2): ${profitRate2}, lossRate.add(lossRate2): ${lossRate2}, accruedProfit.add(accruedProfit2): ${accruedProfit.add(
    //         // //         accruedProfit2,
    //         // //     )}, accruedLoss.add(accruedLoss2): ${accruedLoss.add(accruedLoss2)}`,
    //         // // );
    //         // pnlTracker = await creditPnlManagerContract.getPnL();
    //         // // console.log(`pnlTracker: ${pnlTracker}`);
    //         // checkPnLTracker(
    //         //     pnlTracker,
    //         //     profitRate2,
    //         //     nextTime,
    //         //     accruedProfit.add(accruedProfit2),
    //         //     accruedLoss.add(accruedLoss2),
    //         //     BN.from(0),
    //         //     4,
    //         // );
    //         // creditLoss = await creditPnlManagerContract.getCreditLoss(creditHash);
    //         // checkCreditLoss(creditLoss, accruedLoss, BN.from(0), 3);
    //         // // move forward, refresh browser2 credit and its state becomes defaulted
    //         // nextTime =
    //         //     getNextMonth(
    //         //         preCreditRecord2.nextDueDate.toNumber(),
    //         //         preCreditRecord2.nextDueDate.toNumber(),
    //         //         3 * periodDuration,
    //         //     )[0] +
    //         //     60 * 5;
    //         // await mineNextBlockWithTimestamp(nextTime);
    //         // preCreditRecord2 = creditRecord2;
    //         // await creditContract.refreshCredit(borrower2.address);
    //         // creditRecord2 = await creditContract.getCreditRecord(creditHash2);
    //         // [newCreditRecord2, ,] = calcLateCreditRecord(
    //         //     preCreditRecord2,
    //         //     creditConfig,
    //         //     3,
    //         //     nextTime,
    //         //     creditRecordSettings,
    //         // );
    //         // newCreditRecord2.state = 6;
    //         // checkTwoCreditRecords(creditRecord2, newCreditRecord2);
    //         // accruedProfit2 = BN.from(
    //         //     borrowAmount2.mul(frontLoadingFeeBps).div(CONSTANTS.BP_FACTOR),
    //         // ).add(getPrincipal(creditRecord2).sub(borrowAmount2));
    //         // accruedLoss2 = getPrincipal(creditRecord2);
    //         // pnlTracker = await creditPnlManagerContract.getPnL();
    //         // checkPnLTracker(
    //         //     pnlTracker,
    //         //     BN.from(0),
    //         //     nextTime,
    //         //     accruedProfit.add(accruedProfit2),
    //         //     accruedLoss.add(accruedLoss2),
    //         //     BN.from(0),
    //         //     5,
    //         // );
    //         // creditLoss2 = await creditPnlManagerContract.getCreditLoss(creditHash2);
    //         // checkCreditLoss(creditLoss2, accruedLoss2, BN.from(0), 3);
    //     });
    // });

    describe("triggerDefault", function () {
        // TODO(jiatu): fill this in
    });

    describe("Management Tests", function () {
        // describe("closeCredit", function () {
        //     describe("When the credit is not approved yet", function () {
        //         it("Should not be able to close a non-existent credit", async function () {
        //             await expect(
        //                 creditContract.connect(borrower).closeCredit(borrower.getAddress()),
        //             ).to.be.revertedWithCustomError(creditContract, "notBorrowerOrEA");
        //         });
        //     });
        //
        //     describe("When the credit has been approved", function () {
        //         let creditHash: string;
        //
        //         async function approveCredit(
        //             remainingPeriods: number = 1,
        //             committedAmount: BN = BN.from(0),
        //         ) {
        //             creditHash = await borrowerLevelCreditHash(creditContract, borrower);
        //             await creditContract
        //                 .connect(eaServiceAccount)
        //                 .approveBorrower(
        //                     borrower.address,
        //                     toToken(100_000),
        //                     remainingPeriods,
        //                     1_000,
        //                     committedAmount,
        //                     true,
        //                 );
        //         }
        //
        //         beforeEach(async function () {
        //             await loadFixture(approveCredit);
        //         });
        //
        //         async function testCloseCredit(actor: SignerWithAddress) {
        //             await creditContract.connect(actor).closeCredit(borrower.getAddress());
        //
        //             // Make sure relevant fields have been reset.
        //             const creditRecord = await creditContract.getCreditRecord(creditHash);
        //             expect(creditRecord.state).to.equal(CreditState.Deleted);
        //             expect(creditRecord.remainingPeriods).to.equal(ethers.constants.Zero);
        //             const creditConfig = await creditContract.getCreditConfig(creditHash);
        //             expect(creditConfig.creditLimit).to.equal(ethers.constants.Zero);
        //         }
        //
        //         async function testCloseCreditReversion(actor: SignerWithAddress, errorName: string) {
        //             const oldCreditConfig = await creditContract.getCreditConfig(creditHash);
        //             const oldCreditRecord = await creditContract.getCreditRecord(creditHash);
        //             await expect(
        //                 creditContract.connect(actor).closeCredit(borrower.getAddress()),
        //             ).to.be.revertedWithCustomError(creditContract, errorName);
        //
        //             // Make sure neither credit config nor credit record has changed.
        //             const newCreditConfig = await creditContract.getCreditConfig(creditHash);
        //             checkCreditConfig(
        //                 newCreditConfig,
        //                 oldCreditConfig.creditLimit,
        //                 oldCreditConfig.committedAmount,
        //                 oldCreditConfig.periodDuration,
        //                 oldCreditConfig.numOfPeriods,
        //                 oldCreditConfig.yieldInBps,
        //                 oldCreditConfig.revolving,
        //                 oldCreditConfig.receivableBacked,
        //                 oldCreditConfig.borrowerLevelCredit,
        //                 oldCreditConfig.exclusive,
        //             );
        //             const newCreditRecord = await creditContract.getCreditRecord(creditHash);
        //             checkCreditRecord(
        //                 newCreditRecord,
        //                 oldCreditRecord.unbilledPrincipal,
        //                 oldCreditRecord.nextDueDate,
        //                 oldCreditRecord.nextDue,
        //                 oldCreditRecord.yieldDue,
        //                 oldCreditRecord.missedPeriods,
        //                 oldCreditRecord.remainingPeriods,
        //                 oldCreditRecord.state,
        //             );
        //         }
        //
        //         // TODO(jiatu): test event emission.
        //         it("Should allow the borrower to close a newly approved credit", async function () {
        //             await testCloseCredit(borrower);
        //         });
        //
        //         it("Should allow the evaluation agent to close a newly approved credit", async function () {
        //             await testCloseCredit(eaServiceAccount);
        //         });
        //
        //         it("Should allow the borrower to close a credit that's fully paid back", async function () {
        //             const amount = toToken(1_000);
        //             await creditContract.connect(borrower).drawdown(borrower.getAddress(), amount);
        //             const creditRecord = await creditContract.getCreditRecord(creditHash);
        //             await creditContract
        //                 .connect(borrower)
        //                 .makePayment(
        //                     borrower.getAddress(),
        //                     creditRecord.nextDue.add(creditRecord.unbilledPrincipal),
        //                 );
        //             await testCloseCredit(borrower);
        //         });
        //
        //         it("Should allow the borrower to close a credit that has commitment but has reached maturity", async function () {
        //             // Close the approved credit then open a new one with a different committed amount.
        //             await creditContract.connect(borrower).closeCredit(borrower.getAddress());
        //             await approveCredit(1, toToken(100_000));
        //             // Make one round of drawdown and payment so that the borrower have a credit record.
        //             const amount = toToken(1_000);
        //             await creditContract.connect(borrower).drawdown(borrower.getAddress(), amount);
        //             let creditRecord = await creditContract.getCreditRecord(creditHash);
        //             await creditContract
        //                 .connect(borrower)
        //                 .makePayment(
        //                     borrower.getAddress(),
        //                     creditRecord.nextDue.add(creditRecord.unbilledPrincipal),
        //                 );
        //
        //             // Advance one block so that the remaining period becomes 0.
        //             const creditConfig = await creditContract.getCreditConfig(creditHash);
        //             // TODO: there is some issues with date calculation when a billing cycle starts in the middle of
        //             // of a period, hence the multiplication with 4. Technically speaking we don't need it.
        //             const nextBlockTime = await getFutureBlockTime(
        //                 4 *
        //                     creditConfig.periodDuration *
        //                     CONSTANTS.SECONDS_IN_A_DAY *
        //                     CONSTANTS.DAYS_IN_A_MONTH,
        //             );
        //             await mineNextBlockWithTimestamp(nextBlockTime);
        //             // Make another payment because there is yield due from commitment.
        //             await creditContract.refreshCredit(borrower.getAddress());
        //             creditRecord = await creditContract.getCreditRecord(creditHash);
        //             await creditContract
        //                 .connect(borrower)
        //                 .makePayment(borrower.getAddress(), creditRecord.nextDue);
        //             await testCloseCredit(borrower);
        //         });
        //
        //         it("Should not allow the borrower to close a credit that has upcoming yield due", async function () {
        //             const amount = toToken(1_000);
        //             await creditContract.connect(borrower).drawdown(borrower.getAddress(), amount);
        //             // Only pay back the total principal outstanding.
        //             const creditRecord = await creditContract.getCreditRecord(creditHash);
        //             const totalPrincipal = creditRecord.nextDue
        //                 .sub(creditRecord.yieldDue)
        //                 .add(creditRecord.unbilledPrincipal);
        //             await creditContract
        //                 .connect(borrower)
        //                 .makePayment(borrower.getAddress(), totalPrincipal);
        //             await testCloseCreditReversion(borrower, "creditLineHasOutstandingBalance");
        //         });
        //
        //         it("Should not allow the borrower to close a credit that has past due", async function () {
        //             // TODO(jiatu): fill this in after checking whether the past due logic is correct.
        //             // const amount = toToken(1_000);
        //             // await creditContract.connect(borrower).drawdown(borrower.getAddress(), amount);
        //             //
        //             // // Advance one block so that all due becomes past due.
        //             // const creditConfig = await creditContract.getCreditConfig(creditHash);
        //             // const nextBlockTime = await getFutureBlockTime(4 * creditConfig.periodDuration * CONSTANTS.SECONDS_IN_A_DAY * CONSTANTS.DAYS_IN_A_MONTH);
        //             // await mineNextBlockWithTimestamp(nextBlockTime);
        //             // await creditContract.refreshCredit(borrower.getAddress());
        //             // const creditRecord = await creditContract.getCreditRecord(creditHash);
        //             // // expect(creditRecord.nextDue).to.equal(ethers.constants.Zero);
        //             // expect(creditRecord.totalPastDue).to.be.greaterThan(ethers.constants.Zero);
        //             // expect(creditRecord.unbilledPrincipal).to.equal(ethers.constants.Zero);
        //             // await testCloseCreditReversion(borrower, "creditLineHasOutstandingBalance");
        //         });
        //
        //         it("Should not allow the borrower to close a credit that has outstanding unbilled principal", async function () {
        //             const amount = toToken(1_000);
        //             await creditContract.connect(borrower).drawdown(borrower.getAddress(), amount);
        //             // Only pay back the next due and have unbilled principal outstanding.
        //             const creditRecord = await creditContract.getCreditRecord(creditHash);
        //             await creditContract
        //                 .connect(borrower)
        //                 .makePayment(borrower.getAddress(), creditRecord.nextDue);
        //             await testCloseCreditReversion(borrower, "creditLineHasOutstandingBalance");
        //         });
        //
        //         it("Should not allow the borrower to close a credit that has unfulfilled commitment", async function () {
        //             // Close the approved credit then open a new one with a different committed amount.
        //             await creditContract.connect(borrower).closeCredit(borrower.getAddress());
        //             await approveCredit(3, toToken(100_000));
        //             await testCloseCreditReversion(borrower, "creditLineHasUnfulfilledCommitment");
        //         });
        //     });
        // });

        // describe("pauseCredit and unpauseCredit", function () {
        //     let creditHash: string;
        //
        //     async function approveCredit() {
        //         creditHash = await borrowerLevelCreditHash(creditContract, borrower);
        //         await creditContract
        //             .connect(eaServiceAccount)
        //             .approveBorrower(borrower.address, toToken(100_000), 1, 1_000, toToken(0), true);
        //     }
        //
        //     beforeEach(async function () {
        //         await loadFixture(approveCredit);
        //     });
        //
        //     it("Should allow the EA to pause and unpause a credit", async function () {
        //         await creditContract.connect(borrower).drawdown(borrower.getAddress(), toToken(1_000));
        //         await creditContract.connect(eaServiceAccount).pauseCredit(borrower.getAddress());
        //         let creditRecord = await creditContract.getCreditRecord(creditHash);
        //         expect(creditRecord.state).to.equal(CreditState.Paused);
        //
        //         await creditContract.connect(eaServiceAccount).unpauseCredit(borrower.getAddress());
        //         creditRecord = await creditContract.getCreditRecord(creditHash);
        //         expect(creditRecord.state).to.equal(CreditState.GoodStanding);
        //     });
        //
        //     it("Should do nothing if the credit line is not in the desired states", async function () {
        //         const oldCreditRecord = await creditContract.getCreditRecord(creditHash);
        //         await creditContract.connect(eaServiceAccount).pauseCredit(borrower.getAddress());
        //         let newCreditRecord = await creditContract.getCreditRecord(creditHash);
        //         expect(newCreditRecord.state).to.equal(oldCreditRecord.state);
        //
        //         await creditContract.connect(eaServiceAccount).unpauseCredit(borrower.getAddress());
        //         newCreditRecord = await creditContract.getCreditRecord(creditHash);
        //         expect(newCreditRecord.state).to.equal(oldCreditRecord.state);
        //     });
        // });

        // describe("extendRemainingPeriod", function () {
        //     let creditHash: string;
        //     const numOfPeriods = 2;
        //
        //     async function approveCredit() {
        //         creditHash = await borrowerLevelCreditHash(creditContract, borrower);
        //         await creditContract
        //             .connect(eaServiceAccount)
        //             .approveBorrower(borrower.address, toToken(100_000), 1, 1_000, toToken(0), true);
        //     }
        //
        //     beforeEach(async function () {
        //         await loadFixture(approveCredit);
        //     });
        //
        //     it("Should allow the EA to extend the remaining periods of a credit line", async function () {
        //         const oldCreditRecord = await creditContract.getCreditRecord(creditHash);
        //         const newRemainingPeriods = oldCreditRecord.remainingPeriods + numOfPeriods;
        //         await expect(
        //             creditContract
        //                 .connect(eaServiceAccount)
        //                 .extendRemainingPeriod(borrower.getAddress(), numOfPeriods),
        //         )
        //             .to.emit(creditContract, "RemainingPeriodsExtended")
        //             .withArgs(
        //                 creditHash,
        //                 oldCreditRecord.remainingPeriods,
        //                 newRemainingPeriods,
        //                 await eaServiceAccount.getAddress(),
        //             );
        //         const newCreditRecord = await creditContract.getCreditRecord(creditHash);
        //         expect(newCreditRecord.remainingPeriods).to.equal(newRemainingPeriods);
        //     });
        //
        //     it("Should disallow non-EAs to extend the remaining period", async function () {
        //         await expect(
        //             creditContract
        //                 .connect(borrower)
        //                 .extendRemainingPeriod(borrower.getAddress(), numOfPeriods),
        //         ).to.be.revertedWithCustomError(
        //             creditContract,
        //             "evaluationAgentServiceAccountRequired",
        //         );
        //     });
        // });

        describe("updateLimitAndCommitment", function () {
            let creditHash: string;

            async function approveCredit() {
                creditHash = await borrowerLevelCreditHash(creditContract, borrower);
                await creditContract
                    .connect(eaServiceAccount)
                    .approveBorrower(
                        borrower.address,
                        toToken(100_000),
                        1,
                        1_000,
                        toToken(0),
                        true,
                    );
            }

            beforeEach(async function () {
                await loadFixture(approveCredit);
            });

            it("Should allow the EA to update the credit limit and commitment amount", async function () {
                // TODO(jiatu): fill this in after fixing days passed in period calculation.
            });
        });

        describe("waiveLateFee", function () {
            let creditHash: string;

            async function approveCredit() {
                creditHash = await borrowerLevelCreditHash(creditContract, borrower);
                await creditContract
                    .connect(eaServiceAccount)
                    .approveBorrower(
                        borrower.address,
                        toToken(100_000),
                        1,
                        1_000,
                        toToken(0),
                        true,
                    );
            }

            beforeEach(async function () {
                await loadFixture(approveCredit);
            });

            it("Should allow the EA to partially waive late fees", async function () {
                // TODO(jiatu): fill this in
            });
        });
    });

    describe("Delayed Tests", function () {
        it("Should refresh credit and credit becomes Delayed state", async function () {});

        it("Should not allow drawdowne in Delayed state", async function () {});

        it("Should make partial payment successfully in Delayed state", async function () {});

        it("Should pay total due successfully and credit becomes GoodStanding state", async function () {});

        it("Should pay off successfully in Delayed state", async function () {});
    });

    describe("Defaulted Tests", function () {
        it("Should refresh credit and credit becomes Defaulted state", async function () {});

        it("Should not allow drawdowne in Defaulted state", async function () {});

        it("Should make partial payment successfully in Defaulted state", async function () {});

        it("Should pay off successfully in Defaulted state", async function () {});
    });
});
