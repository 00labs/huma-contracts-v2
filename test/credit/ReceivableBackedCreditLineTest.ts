import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { BigNumber as BN } from "ethers";
import { ethers } from "hardhat";
import {
    Calendar,
    CreditDueManager,
    EpochManager,
    EvaluationAgentNFT,
    FirstLossCover,
    HumaConfig,
    MockToken,
    Pool,
    PoolConfig,
    PoolFeeManager,
    PoolSafe,
    Receivable,
    ReceivableBackedCreditLine,
    ReceivableBackedCreditLineManager,
    RiskAdjustedTranchesPolicy,
    TrancheVault,
} from "../../typechain-types";
import {
    CONSTANTS,
    CreditState,
    PayPeriodDuration,
    calcPrincipalDueForFullPeriods,
    calcPrincipalDueForPartialPeriod,
    calcYield,
    calcYieldDue,
    checkCreditRecord,
    checkCreditRecordsMatch,
    checkDueDetailsMatch,
    deployAndSetupPoolContracts,
    deployProtocolContracts,
    genDueDetail,
} from "../BaseTest";
import {
    borrowerLevelCreditHash,
    getFutureBlockTime,
    getLatestBlock,
    mineNextBlockWithTimestamp,
    setNextBlockTimestamp,
    toToken,
} from "../TestUtils";

let defaultDeployer: SignerWithAddress,
    protocolOwner: SignerWithAddress,
    treasury: SignerWithAddress,
    eaServiceAccount: SignerWithAddress,
    sentinelServiceAccount: SignerWithAddress;
let poolOwner: SignerWithAddress,
    poolOwnerTreasury: SignerWithAddress,
    evaluationAgent: SignerWithAddress,
    poolOperator: SignerWithAddress;
let lender: SignerWithAddress, borrower: SignerWithAddress;

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
    creditContract: ReceivableBackedCreditLine,
    creditDueManagerContract: CreditDueManager,
    creditManagerContract: ReceivableBackedCreditLineManager,
    receivableContract: Receivable;

describe("ReceivableBackedCreditLine Tests", function () {
    before(async function () {
        [
            defaultDeployer,
            protocolOwner,
            treasury,
            eaServiceAccount,
            sentinelServiceAccount,
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
            sentinelServiceAccount,
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
            creditManagerContract as unknown,
        ] = await deployAndSetupPoolContracts(
            humaConfigContract,
            mockTokenContract,
            eaNFTContract,
            "RiskAdjustedTranchesPolicy",
            defaultDeployer,
            poolOwner,
            "ReceivableBackedCreditLine",
            "ReceivableBackedCreditLineManager",
            evaluationAgent,
            poolOwnerTreasury,
            poolOperator,
            [lender, borrower],
        );

        const Receivable = await ethers.getContractFactory("Receivable");
        receivableContract = await Receivable.deploy();
        await receivableContract.deployed();

        await receivableContract.connect(poolOwner).initialize();
        await receivableContract
            .connect(poolOwner)
            .grantRole(receivableContract.MINTER_ROLE(), borrower.address);
        await receivableContract
            .connect(poolOwner)
            .grantRole(receivableContract.MINTER_ROLE(), lender.address);
        await poolConfigContract.connect(poolOwner).setReceivableAsset(receivableContract.address);

        await borrowerFirstLossCoverContract.connect(poolOwner).addCoverProvider(borrower.address);
        await mockTokenContract
            .connect(borrower)
            .approve(borrowerFirstLossCoverContract.address, ethers.constants.MaxUint256);

        await juniorTrancheVaultContract
            .connect(lender)
            .deposit(toToken(10_000_000), lender.address);
    }

    beforeEach(async function () {
        await loadFixture(prepare);
    });

    describe("getNextBillRefreshDate and getDueInfo", function () {
        const yieldInBps = 1217,
            principalRate = 100,
            lateFeeBps = 2400;
        const numOfPeriods = 3,
            latePaymentGracePeriodInDays = 5;
        let committedAmount: BN, borrowAmount: BN, tokenId: BN;
        let creditHash: string;

        async function prepareForGetDueInfo() {
            const settings = await poolConfigContract.getPoolSettings();
            await poolConfigContract.connect(poolOwner).setPoolSettings({
                ...settings,
                ...{
                    latePaymentGracePeriodInDays: latePaymentGracePeriodInDays,
                    advanceRateInBps: CONSTANTS.BP_FACTOR,
                    receivableAutoApproval: true,
                },
            });
            await poolConfigContract.connect(poolOwner).setFeeStructure({
                yieldInBps,
                minPrincipalRateInBps: principalRate,
                lateFeeBps,
            });

            committedAmount = toToken(10_000);
            borrowAmount = toToken(15_000);
            creditHash = await borrowerLevelCreditHash(creditContract, borrower);

            await creditManagerContract
                .connect(eaServiceAccount)
                .approveBorrower(
                    borrower.getAddress(),
                    toToken(100_000),
                    numOfPeriods,
                    yieldInBps,
                    committedAmount,
                    0,
                    true,
                );

            const currentTS = (await getLatestBlock()).timestamp;
            const maturityDate =
                currentTS + CONSTANTS.SECONDS_IN_A_DAY * CONSTANTS.DAYS_IN_A_MONTH;
            await receivableContract
                .connect(borrower)
                .createReceivable(1, borrowAmount, maturityDate, "", "");
            tokenId = await receivableContract.tokenOfOwnerByIndex(borrower.getAddress(), 0);
            await receivableContract.connect(borrower).approve(creditContract.address, tokenId);
        }

        beforeEach(async function () {
            await loadFixture(prepareForGetDueInfo);
        });

        it("Should return the latest bill for the borrower", async function () {
            await creditContract
                .connect(borrower)
                .drawdownWithReceivable(
                    borrower.getAddress(),
                    { receivableAmount: borrowAmount, receivableId: tokenId },
                    borrowAmount,
                );

            const oldCR = await creditContract.getCreditRecord(creditHash);
            const latePaymentDeadline =
                oldCR.nextDueDate.toNumber() +
                latePaymentGracePeriodInDays * CONSTANTS.SECONDS_IN_A_DAY;
            const viewTime = latePaymentDeadline + 100;
            await mineNextBlockWithTimestamp(viewTime);

            const cc = await creditManagerContract.getCreditConfig(creditHash);
            const nextDueDate = await calendarContract.getStartDateOfNextPeriod(
                cc.periodDuration,
                viewTime,
            );
            const [accruedYieldDue, committedYieldDue] = calcYieldDue(
                cc,
                borrowAmount,
                CONSTANTS.DAYS_IN_A_MONTH,
            );
            expect(accruedYieldDue).to.be.gt(committedYieldDue);
            const principalDue = calcPrincipalDueForFullPeriods(
                oldCR.unbilledPrincipal,
                principalRate,
                1,
            );
            const nextDue = accruedYieldDue.add(principalDue);
            const tomorrow = await calendarContract.getStartOfNextDay(viewTime);
            const lateFee = calcYield(borrowAmount, lateFeeBps, latePaymentGracePeriodInDays + 1);
            expect(lateFee).to.be.gt(0);

            const refreshDate = await creditContract.getNextBillRefreshDate(borrower.getAddress());
            expect(refreshDate).to.equal(latePaymentDeadline);
            const [actualCR, actualDD] = await creditContract.getDueInfo(borrower.getAddress());
            const expectedCR = {
                unbilledPrincipal: oldCR.unbilledPrincipal.sub(principalDue),
                nextDueDate,
                nextDue,
                yieldDue: accruedYieldDue,
                totalPastDue: oldCR.nextDue.add(lateFee),
                missedPeriods: 1,
                remainingPeriods: oldCR.remainingPeriods - 1,
                state: CreditState.Delayed,
            };
            checkCreditRecordsMatch(actualCR, expectedCR);
            const expectedDD = genDueDetail({
                lateFeeUpdatedDate: tomorrow,
                lateFee: lateFee,
                yieldPastDue: oldCR.yieldDue,
                principalPastDue: oldCR.nextDue.sub(oldCR.yieldDue),
                accrued: accruedYieldDue,
                committed: committedYieldDue,
            });
            checkDueDetailsMatch(actualDD, expectedDD);
        });
    });

    describe("drawdownWithReceivable", function () {
        const yieldInBps = 1217,
            principalRate = 100,
            lateFeeBps = 2400;
        const numOfPeriods = 3,
            latePaymentGracePeriodInDays = 5;
        let maturityDate: number;
        let committedAmount: BN, borrowAmount: BN, tokenId: BN;
        let creditHash: string;

        async function prepareForDrawdown() {
            const settings = await poolConfigContract.getPoolSettings();
            await poolConfigContract.connect(poolOwner).setPoolSettings({
                ...settings,
                ...{
                    payPeriodDuration: PayPeriodDuration.Monthly,
                    latePaymentGracePeriodInDays: latePaymentGracePeriodInDays,
                    advanceRateInBps: CONSTANTS.BP_FACTOR,
                    receivableAutoApproval: true,
                },
            });

            await poolConfigContract.connect(poolOwner).setFeeStructure({
                yieldInBps,
                minPrincipalRateInBps: principalRate,
                lateFeeBps,
            });

            committedAmount = toToken(10_000);
            borrowAmount = toToken(15_000);
            creditHash = await borrowerLevelCreditHash(creditContract, borrower);

            const currentTS = (await getLatestBlock()).timestamp;
            maturityDate = currentTS + CONSTANTS.SECONDS_IN_A_DAY * CONSTANTS.DAYS_IN_A_MONTH;
            await receivableContract
                .connect(borrower)
                .createReceivable(1, borrowAmount, maturityDate, "", "");
            tokenId = await receivableContract.tokenOfOwnerByIndex(borrower.getAddress(), 0);
            await receivableContract.connect(borrower).approve(creditContract.address, tokenId);
        }

        async function approveBorrower() {
            await creditManagerContract
                .connect(eaServiceAccount)
                .approveBorrower(
                    borrower.getAddress(),
                    toToken(100_000),
                    numOfPeriods,
                    yieldInBps,
                    committedAmount,
                    0,
                    true,
                );
        }

        beforeEach(async function () {
            await loadFixture(prepareForDrawdown);
        });

        describe("Without credit approval", function () {
            it("Should not allow drawdown by the borrower", async function () {
                await expect(
                    creditContract.connect(borrower).drawdownWithReceivable(
                        borrower.getAddress(),
                        {
                            receivableAmount: borrowAmount,
                            receivableId: tokenId,
                        },
                        borrowAmount,
                    ),
                ).to.be.revertedWithCustomError(creditManagerContract, "notBorrower");
            });
        });

        describe("With credit approval", function () {
            beforeEach(async function () {
                await loadFixture(approveBorrower);
            });

            it("Should allow the borrower to drawdown", async function () {
                const borrowAmount = toToken(50_000);
                const netBorrowAmount = borrowAmount;
                const drawdownDate = await getFutureBlockTime(3);
                await setNextBlockTimestamp(drawdownDate);

                const cc = await creditManagerContract.getCreditConfig(creditHash);
                const nextDueDate = await calendarContract.getStartDateOfNextPeriod(
                    cc.periodDuration,
                    drawdownDate,
                );
                const daysRemainingInPeriod = (
                    await calendarContract.getDaysDiff(drawdownDate, nextDueDate)
                ).toNumber();
                const [accruedYieldDue, committedYieldDue] = calcYieldDue(
                    cc,
                    borrowAmount,
                    daysRemainingInPeriod,
                );
                const principalDue = calcPrincipalDueForPartialPeriod(
                    borrowAmount,
                    principalRate,
                    daysRemainingInPeriod,
                    CONSTANTS.DAYS_IN_A_MONTH,
                );
                const nextDue = accruedYieldDue.add(principalDue);

                const borrowerOldBalance = await mockTokenContract.balanceOf(
                    borrower.getAddress(),
                );
                await expect(
                    creditContract
                        .connect(borrower)
                        .drawdownWithReceivable(
                            borrower.getAddress(),
                            { receivableAmount: borrowAmount, receivableId: tokenId },
                            borrowAmount,
                        ),
                )
                    .to.emit(creditContract, "DrawdownMade")
                    .withArgs(await borrower.getAddress(), borrowAmount, netBorrowAmount)
                    .to.emit(creditContract, "DrawdownMadeWithReceivable")
                    .withArgs(
                        await borrower.getAddress(),
                        tokenId,
                        borrowAmount,
                        borrowAmount,
                        await borrower.getAddress(),
                    )
                    .to.emit(creditContract, "BillRefreshed")
                    .withArgs(creditHash, nextDueDate, nextDue);
                const borrowerNewBalance = await mockTokenContract.balanceOf(
                    borrower.getAddress(),
                );
                expect(borrowerNewBalance.sub(borrowerOldBalance)).to.equal(netBorrowAmount);

                const actualCR = await creditContract.getCreditRecord(creditHash);
                checkCreditRecord(
                    actualCR,
                    borrowAmount.sub(principalDue),
                    nextDueDate,
                    nextDue,
                    accruedYieldDue,
                    BN.from(0),
                    0,
                    numOfPeriods - 1,
                    CreditState.GoodStanding,
                );

                const actualDD = await creditContract.getDueDetail(creditHash);
                checkDueDetailsMatch(
                    actualDD,
                    genDueDetail({ accrued: accruedYieldDue, committed: committedYieldDue }),
                );
            });

            it("Should not allow drawdown when the protocol is paused or pool is not on", async function () {
                await humaConfigContract.connect(protocolOwner).pause();
                await expect(
                    creditContract.drawdownWithReceivable(
                        borrower.getAddress(),
                        { receivableAmount: borrowAmount, receivableId: 1 },
                        borrowAmount,
                    ),
                ).to.be.revertedWithCustomError(poolConfigContract, "protocolIsPaused");
                await humaConfigContract.connect(protocolOwner).unpause();

                await poolContract.connect(poolOwner).disablePool();
                await expect(
                    creditContract.drawdownWithReceivable(
                        borrower.getAddress(),
                        { receivableAmount: borrowAmount, receivableId: 1 },
                        borrowAmount,
                    ),
                ).to.be.revertedWithCustomError(poolConfigContract, "poolIsNotOn");
                await poolContract.connect(poolOwner).enablePool();
            });

            it("Should not allow drawdown by non-borrowers", async function () {
                await expect(
                    creditContract.connect(lender).drawdownWithReceivable(
                        borrower.getAddress(),
                        {
                            receivableAmount: borrowAmount,
                            receivableId: tokenId,
                        },
                        borrowAmount,
                    ),
                ).to.be.revertedWithCustomError(creditContract, "notBorrower");
            });

            it("Should not allow drawdown with 0 receivable amount", async function () {
                await expect(
                    creditContract.connect(borrower).drawdownWithReceivable(
                        borrower.getAddress(),
                        {
                            receivableAmount: 0,
                            receivableId: tokenId,
                        },
                        borrowAmount,
                    ),
                ).to.be.revertedWithCustomError(creditContract, "zeroAmountProvided");
            });

            it("Should not allow drawdown with 0 receivable ID", async function () {
                await expect(
                    creditContract.connect(borrower).drawdownWithReceivable(
                        borrower.getAddress(),
                        {
                            receivableAmount: borrowAmount,
                            receivableId: 0,
                        },
                        borrowAmount,
                    ),
                ).to.be.revertedWithCustomError(creditContract, "zeroReceivableIdProvided");
            });

            it("Should not allow drawdown if the amount exceeds the receivable amount", async function () {
                await expect(
                    creditContract.connect(borrower).drawdownWithReceivable(
                        borrower.getAddress(),
                        {
                            receivableAmount: borrowAmount.sub(toToken(1)),
                            receivableId: tokenId,
                        },
                        borrowAmount,
                    ),
                ).to.be.revertedWithCustomError(creditContract, "insufficientReceivableAmount");
            });

            it("Should not allow drawdown with 0 borrow amount", async function () {
                await expect(
                    creditContract.connect(borrower).drawdownWithReceivable(
                        borrower.getAddress(),
                        {
                            receivableAmount: borrowAmount,
                            receivableId: tokenId,
                        },
                        0,
                    ),
                ).to.be.revertedWithCustomError(creditContract, "zeroAmountProvided");
            });

            it("Should not allow drawdown if the borrower does not own the receivable", async function () {
                await receivableContract
                    .connect(lender)
                    .createReceivable(1, borrowAmount, maturityDate, "", "");
                const tokenId2 = await receivableContract.tokenOfOwnerByIndex(
                    lender.getAddress(),
                    0,
                );
                await receivableContract.connect(lender).approve(creditContract.address, tokenId2);

                await expect(
                    creditContract.connect(borrower).drawdownWithReceivable(
                        borrower.getAddress(),
                        {
                            receivableAmount: borrowAmount,
                            receivableId: tokenId2,
                        },
                        borrowAmount,
                    ),
                ).to.be.revertedWithCustomError(creditContract, "notReceivableOwner");

                await receivableContract.connect(lender).burn(tokenId2);
            });

            it("Should not allow drawdown if the receivable is not approved", async function () {
                const settings = await poolConfigContract.getPoolSettings();
                await poolConfigContract.connect(poolOwner).setPoolSettings({
                    ...settings,
                    ...{
                        receivableAutoApproval: false,
                    },
                });
                // Re-approve so that the auto approval is overwritten to be `false`.
                await approveBorrower();

                await expect(
                    creditContract.connect(borrower).drawdownWithReceivable(
                        borrower.getAddress(),
                        {
                            receivableAmount: borrowAmount,
                            receivableId: tokenId,
                        },
                        borrowAmount,
                    ),
                ).to.be.revertedWithCustomError(creditManagerContract, "receivableIdMismatch");

                await poolConfigContract.connect(poolOwner).setPoolSettings(settings);
            });
        });
    });

    describe("makePaymentWithReceivable", function () {
        const yieldInBps = 1217,
            principalRate = 100,
            lateFeeBps = 2400;
        const numOfPeriods = 3,
            latePaymentGracePeriodInDays = 5;
        let maturityDate: number;
        let committedAmount: BN, borrowAmount: BN, tokenId: BN;
        let creditHash: string;

        async function prepareForMakePayment() {
            const settings = await poolConfigContract.getPoolSettings();
            await poolConfigContract.connect(poolOwner).setPoolSettings({
                ...settings,
                ...{
                    latePaymentGracePeriodInDays: latePaymentGracePeriodInDays,
                    advanceRateInBps: CONSTANTS.BP_FACTOR,
                    receivableAutoApproval: true,
                },
            });
            await poolConfigContract.connect(poolOwner).setFeeStructure({
                yieldInBps,
                minPrincipalRateInBps: principalRate,
                lateFeeBps,
            });

            committedAmount = toToken(10_000);
            borrowAmount = toToken(15_000);
            creditHash = await borrowerLevelCreditHash(creditContract, borrower);

            const currentTS = (await getLatestBlock()).timestamp;
            maturityDate = currentTS + CONSTANTS.SECONDS_IN_A_DAY * CONSTANTS.DAYS_IN_A_MONTH;
            await receivableContract
                .connect(borrower)
                .createReceivable(1, borrowAmount, maturityDate, "", "");
            tokenId = await receivableContract.tokenOfOwnerByIndex(borrower.getAddress(), 0);
            await receivableContract.connect(borrower).approve(creditContract.address, tokenId);
        }

        async function approveAndDrawdown() {
            await creditManagerContract
                .connect(eaServiceAccount)
                .approveBorrower(
                    borrower.getAddress(),
                    toToken(100_000),
                    numOfPeriods,
                    yieldInBps,
                    committedAmount,
                    0,
                    true,
                );
            await creditContract.connect(borrower).drawdownWithReceivable(
                borrower.getAddress(),
                {
                    receivableAmount: borrowAmount,
                    receivableId: tokenId,
                },
                borrowAmount,
            );
        }

        beforeEach(async function () {
            await loadFixture(prepareForMakePayment);
        });

        describe("Without credit approval", function () {
            it("Should not allow payment on a non-existent credit", async function () {
                await expect(
                    creditContract
                        .connect(borrower)
                        .makePaymentWithReceivable(borrower.getAddress(), tokenId, borrowAmount),
                ).to.be.revertedWithCustomError(creditManagerContract, "notBorrower");
            });
        });

        describe("With credit approval", function () {
            beforeEach(async function () {
                await loadFixture(approveAndDrawdown);
            });

            it("Should allow the borrower to make payment", async function () {
                const oldCR = await creditContract.getCreditRecord(creditHash);
                const oldDD = await creditContract.getDueDetail(creditHash);
                const paymentAmount = oldCR.yieldDue;

                await expect(
                    creditContract
                        .connect(borrower)
                        .makePaymentWithReceivable(borrower.getAddress(), tokenId, paymentAmount),
                )
                    .to.emit(creditContract, "PaymentMade")
                    .withArgs(
                        await borrower.getAddress(),
                        await borrower.getAddress(),
                        paymentAmount,
                        oldCR.yieldDue,
                        0,
                        0,
                        0,
                        0,
                        0,
                        await borrower.getAddress(),
                    )
                    .to.emit(creditContract, "PaymentMadeWithReceivable")
                    .withArgs(
                        await borrower.getAddress(),
                        tokenId,
                        paymentAmount,
                        await borrower.getAddress(),
                    );

                const actualCR = await creditContract.getCreditRecord(creditHash);
                const expectedCR = {
                    ...oldCR,
                    ...{
                        nextDue: oldCR.nextDue.sub(oldCR.yieldDue),
                        yieldDue: 0,
                    },
                };
                checkCreditRecordsMatch(actualCR, expectedCR);

                const actualDD = await creditContract.getDueDetail(creditHash);
                const expectedDD = {
                    ...oldDD,
                    ...{
                        paid: paymentAmount,
                    },
                };
                checkDueDetailsMatch(actualDD, expectedDD);
            });

            it("Should not allow payment when the protocol is paused or the pool is not on", async function () {
                await humaConfigContract.connect(protocolOwner).pause();
                await expect(
                    creditContract
                        .connect(borrower)
                        .makePaymentWithReceivable(borrower.getAddress(), tokenId, borrowAmount),
                ).to.be.revertedWithCustomError(poolConfigContract, "protocolIsPaused");
                await humaConfigContract.connect(protocolOwner).unpause();

                await poolContract.connect(poolOwner).disablePool();
                await expect(
                    creditContract
                        .connect(borrower)
                        .makePaymentWithReceivable(borrower.getAddress(), tokenId, borrowAmount),
                ).to.be.revertedWithCustomError(poolConfigContract, "poolIsNotOn");
                await poolContract.connect(poolOwner).enablePool();
            });

            it("Should not allow payment by non-borrower or non-Sentinel Service account", async function () {
                await expect(
                    creditContract
                        .connect(lender)
                        .makePaymentWithReceivable(borrower.getAddress(), tokenId, borrowAmount),
                ).to.be.revertedWithCustomError(creditContract, "sentinelServiceAccountRequired");
            });

            it("Should not allow payment with 0 receivable ID", async function () {
                await expect(
                    creditContract
                        .connect(borrower)
                        .makePaymentWithReceivable(borrower.getAddress(), 0, borrowAmount),
                ).to.be.revertedWithCustomError(creditContract, "zeroReceivableIdProvided");
            });

            it("Should not allow payment if the receivable wasn't transferred to the contract", async function () {
                // Create another receivable that wasn't used for drawdown, hence not transferred to the contract.
                await receivableContract
                    .connect(borrower)
                    .createReceivable(2, borrowAmount, maturityDate, "", "");
                const balance = await receivableContract.balanceOf(borrower.getAddress());
                expect(balance).to.equal(1);
                const tokenId2 = await receivableContract.tokenOfOwnerByIndex(
                    borrower.getAddress(),
                    0,
                );
                await receivableContract
                    .connect(borrower)
                    .approve(creditContract.address, tokenId2);
                await creditManagerContract
                    .connect(eaServiceAccount)
                    .approveReceivable(borrower.getAddress(), {
                        receivableAmount: borrowAmount,
                        receivableId: tokenId2,
                    });

                await expect(
                    creditContract
                        .connect(borrower)
                        .makePaymentWithReceivable(borrower.getAddress(), tokenId2, borrowAmount),
                ).to.be.revertedWithCustomError(creditContract, "notReceivableOwner");

                await receivableContract.connect(borrower).burn(tokenId2);
            });
        });
    });

    describe("makePrincipalPaymentWithReceivable", function () {
        const yieldInBps = 1217,
            principalRate = 100,
            lateFeeBps = 2400;
        const numOfPeriods = 3,
            latePaymentGracePeriodInDays = 5;
        let maturityDate: number;
        let committedAmount: BN, borrowAmount: BN, tokenId: BN;
        let creditHash: string;

        async function prepareForMakePayment() {
            const settings = await poolConfigContract.getPoolSettings();
            await poolConfigContract.connect(poolOwner).setPoolSettings({
                ...settings,
                ...{
                    latePaymentGracePeriodInDays: latePaymentGracePeriodInDays,
                    advanceRateInBps: CONSTANTS.BP_FACTOR,
                    receivableAutoApproval: true,
                },
            });
            await poolConfigContract.connect(poolOwner).setFeeStructure({
                yieldInBps,
                minPrincipalRateInBps: principalRate,
                lateFeeBps,
            });

            committedAmount = toToken(10_000);
            borrowAmount = toToken(15_000);
            creditHash = await borrowerLevelCreditHash(creditContract, borrower);

            const currentTS = (await getLatestBlock()).timestamp;
            maturityDate = currentTS + CONSTANTS.SECONDS_IN_A_DAY * CONSTANTS.DAYS_IN_A_MONTH;
            await receivableContract
                .connect(borrower)
                .createReceivable(1, borrowAmount, maturityDate, "", "");
            tokenId = await receivableContract.tokenOfOwnerByIndex(borrower.getAddress(), 0);
            await receivableContract.connect(borrower).approve(creditContract.address, tokenId);
        }

        async function approveBorrowerAndDrawdown() {
            await creditManagerContract
                .connect(eaServiceAccount)
                .approveBorrower(
                    borrower.getAddress(),
                    toToken(100_000),
                    numOfPeriods,
                    yieldInBps,
                    committedAmount,
                    0,
                    true,
                );
            await creditContract.connect(borrower).drawdownWithReceivable(
                borrower.getAddress(),
                {
                    receivableAmount: borrowAmount,
                    receivableId: tokenId,
                },
                borrowAmount,
            );
        }

        beforeEach(async function () {
            await loadFixture(prepareForMakePayment);
        });

        describe("Without credit approval", function () {
            it("Should not allow payment on a non-existent credit", async function () {
                await expect(
                    creditContract
                        .connect(borrower)
                        .makePrincipalPaymentWithReceivable(
                            borrower.getAddress(),
                            tokenId,
                            borrowAmount,
                        ),
                ).to.be.revertedWithCustomError(creditManagerContract, "notBorrower");
            });
        });

        describe("With credit approval", function () {
            beforeEach(async function () {
                await loadFixture(approveBorrowerAndDrawdown);
            });

            it("Should allow the borrower to make payment", async function () {
                const oldCR = await creditContract.getCreditRecord(creditHash);
                const oldDD = await creditContract.getDueDetail(creditHash);
                const paymentAmount = oldCR.nextDue.sub(oldCR.yieldDue);

                await expect(
                    creditContract
                        .connect(borrower)
                        .makePrincipalPaymentWithReceivable(
                            borrower.getAddress(),
                            tokenId,
                            paymentAmount,
                        ),
                )
                    .to.emit(creditContract, "PrincipalPaymentMade")
                    .withArgs(
                        await borrower.getAddress(),
                        await borrower.getAddress(),
                        paymentAmount,
                        oldCR.nextDueDate,
                        0,
                        oldCR.unbilledPrincipal,
                        paymentAmount,
                        0,
                        await borrower.getAddress(),
                    )
                    .to.emit(creditContract, "PrincipalPaymentMadeWithReceivable")
                    .withArgs(
                        await borrower.getAddress(),
                        tokenId,
                        paymentAmount,
                        await borrower.getAddress(),
                    );

                const actualCR = await creditContract.getCreditRecord(creditHash);
                const expectedCR = {
                    ...oldCR,
                    ...{
                        nextDue: oldCR.yieldDue,
                        yieldDue: oldCR.yieldDue,
                    },
                };
                checkCreditRecordsMatch(actualCR, expectedCR);

                const actualDD = await creditContract.getDueDetail(creditHash);
                const expectedDD = oldDD;
                checkDueDetailsMatch(actualDD, expectedDD);
            });

            it("Should not allow payment when the protocol is paused or pool is not on", async function () {
                await humaConfigContract.connect(protocolOwner).pause();
                await expect(
                    creditContract
                        .connect(borrower)
                        .makePrincipalPaymentWithReceivable(
                            borrower.getAddress(),
                            tokenId,
                            borrowAmount,
                        ),
                ).to.be.revertedWithCustomError(poolConfigContract, "protocolIsPaused");
                await humaConfigContract.connect(protocolOwner).unpause();

                await poolContract.connect(poolOwner).disablePool();
                await expect(
                    creditContract
                        .connect(borrower)
                        .makePrincipalPaymentWithReceivable(
                            borrower.getAddress(),
                            tokenId,
                            borrowAmount,
                        ),
                ).to.be.revertedWithCustomError(poolConfigContract, "poolIsNotOn");
                await poolContract.connect(poolOwner).enablePool();
            });

            it("Should not allow payment by non-borrower", async function () {
                await expect(
                    creditContract
                        .connect(lender)
                        .makePrincipalPaymentWithReceivable(
                            borrower.getAddress(),
                            tokenId,
                            borrowAmount,
                        ),
                ).to.be.revertedWithCustomError(creditContract, "notBorrower");
            });

            it("Should not allow payment with 0 receivable ID", async function () {
                await expect(
                    creditContract
                        .connect(borrower)
                        .makePrincipalPaymentWithReceivable(
                            borrower.getAddress(),
                            0,
                            borrowAmount,
                        ),
                ).to.be.revertedWithCustomError(creditContract, "zeroReceivableIdProvided");
            });

            it("Should not allow payment if the receivable wasn't transferred to the contract", async function () {
                // Create another receivable that wasn't used for drawdown, hence not transferred to the contract.
                await receivableContract
                    .connect(borrower)
                    .createReceivable(2, borrowAmount, maturityDate, "", "");
                const balance = await receivableContract.balanceOf(borrower.getAddress());
                expect(balance).to.equal(1);
                const tokenId2 = await receivableContract.tokenOfOwnerByIndex(
                    borrower.getAddress(),
                    0,
                );
                await receivableContract
                    .connect(borrower)
                    .approve(creditContract.address, tokenId2);
                await creditManagerContract
                    .connect(eaServiceAccount)
                    .approveReceivable(borrower.getAddress(), {
                        receivableAmount: borrowAmount,
                        receivableId: tokenId2,
                    });

                await expect(
                    creditContract
                        .connect(borrower)
                        .makePrincipalPaymentWithReceivable(
                            borrower.getAddress(),
                            tokenId2,
                            borrowAmount,
                        ),
                ).to.be.revertedWithCustomError(creditContract, "notReceivableOwner");

                await receivableContract.connect(borrower).burn(tokenId2);
            });
        });
    });

    describe("makePrincipalPaymentAndDrawdownWithReceivable", function () {
        const yieldInBps = 1217,
            principalRate = 100,
            lateFeeBps = 2400;
        const numOfPeriods = 3,
            latePaymentGracePeriodInDays = 5;
        let paymentReceivableMaturityDate: number,
            drawdownReceivableMaturityDate: number,
            designatedStartDate: number;
        let paymentAmount: BN, drawdownAmount: BN, paymentTokenId: BN, drawdownTokenId: BN;
        let creditHash: string;

        async function prepareForMakePaymentAndDrawdown() {
            const settings = await poolConfigContract.getPoolSettings();
            await poolConfigContract.connect(poolOwner).setPoolSettings({
                ...settings,
                ...{
                    latePaymentGracePeriodInDays: latePaymentGracePeriodInDays,
                    advanceRateInBps: CONSTANTS.BP_FACTOR,
                    receivableAutoApproval: true,
                },
            });
            await poolConfigContract.connect(poolOwner).setFeeStructure({
                yieldInBps,
                minPrincipalRateInBps: principalRate,
                lateFeeBps,
            });

            paymentAmount = toToken(15_000);
            creditHash = await borrowerLevelCreditHash(creditContract, borrower);

            const currentTS = (await getLatestBlock()).timestamp;
            paymentReceivableMaturityDate =
                currentTS + CONSTANTS.SECONDS_IN_A_DAY * CONSTANTS.DAYS_IN_A_MONTH;
            drawdownReceivableMaturityDate =
                paymentReceivableMaturityDate +
                CONSTANTS.SECONDS_IN_A_DAY * CONSTANTS.DAYS_IN_A_MONTH;
            // Create two receivables, one ce payment and another one for drawdown.
            await receivableContract
                .connect(borrower)
                .createReceivable(1, paymentAmount, paymentReceivableMaturityDate, "", "");
            paymentTokenId = await receivableContract.tokenOfOwnerByIndex(
                borrower.getAddress(),
                0,
            );
            await receivableContract
                .connect(borrower)
                .approve(creditContract.address, paymentTokenId);
            await receivableContract
                .connect(borrower)
                .createReceivable(
                    1,
                    paymentAmount.add(toToken(5_000)),
                    drawdownReceivableMaturityDate,
                    "",
                    "",
                );
            drawdownTokenId = await receivableContract.tokenOfOwnerByIndex(
                borrower.getAddress(),
                1,
            );
            await receivableContract
                .connect(borrower)
                .approve(creditContract.address, drawdownTokenId);
        }

        async function approveBorrower() {
            designatedStartDate = await getFutureBlockTime(2);
            await creditManagerContract
                .connect(eaServiceAccount)
                .approveBorrower(
                    borrower.getAddress(),
                    toToken(100_000),
                    numOfPeriods,
                    yieldInBps,
                    toToken(5_000),
                    designatedStartDate,
                    true,
                );
        }

        async function initialDrawdown() {
            await creditContract.connect(borrower).drawdownWithReceivable(
                borrower.getAddress(),
                {
                    receivableAmount: paymentAmount,
                    receivableId: paymentTokenId,
                },
                paymentAmount,
            );
        }

        beforeEach(async function () {
            await loadFixture(prepareForMakePaymentAndDrawdown);
        });

        describe("Without credit approval", function () {
            it("Should not allow payment on a non-existent credit", async function () {
                await expect(
                    creditContract
                        .connect(borrower)
                        .makePrincipalPaymentAndDrawdownWithReceivable(
                            borrower.getAddress(),
                            paymentTokenId,
                            paymentAmount,
                            { receivableAmount: paymentAmount, receivableId: drawdownTokenId },
                            paymentAmount,
                        ),
                ).to.be.revertedWithCustomError(creditManagerContract, "notBorrower");
            });

            it("Should not allow payment and drawdown if the receivable for drawdown is not approved", async function () {
                const settings = await poolConfigContract.getPoolSettings();
                await poolConfigContract.connect(poolOwner).setPoolSettings({
                    ...settings,
                    ...{
                        receivableAutoApproval: false,
                    },
                });
                await approveBorrower();
                // Manually approve the receivable for first drawdown.
                await creditManagerContract
                    .connect(eaServiceAccount)
                    .approveReceivable(borrower.getAddress(), {
                        receivableAmount: paymentAmount,
                        receivableId: paymentTokenId,
                    });
                await initialDrawdown();
                // Create another receivable for second drawdown, but this receivable won't be approved.
                await receivableContract
                    .connect(borrower)
                    .createReceivable(1, paymentAmount, drawdownReceivableMaturityDate, "", "");
                const drawdownTokenId2 = await receivableContract.tokenOfOwnerByIndex(
                    borrower.getAddress(),
                    1,
                );
                await receivableContract
                    .connect(borrower)
                    .approve(creditContract.address, drawdownTokenId2);

                await expect(
                    creditContract
                        .connect(borrower)
                        .makePrincipalPaymentAndDrawdownWithReceivable(
                            borrower.getAddress(),
                            paymentTokenId,
                            paymentAmount,
                            { receivableAmount: paymentAmount, receivableId: drawdownTokenId2 },
                            paymentAmount,
                        ),
                ).to.be.revertedWithCustomError(creditManagerContract, "receivableIdMismatch");

                await poolConfigContract.connect(poolOwner).setPoolSettings(settings);
                await receivableContract.connect(borrower).burn(drawdownTokenId2);
            });
        });

        describe("With credit approval but no initial drawdown", function () {
            beforeEach(async function () {
                await loadFixture(approveBorrower);
            });

            it("Should allow a no-op payment", async function () {
                // Start committed credit so that there is commitment outstanding, but no principal outstanding.
                await creditManagerContract
                    .connect(poolOwner)
                    .startCommittedCredit(borrower.getAddress());

                const oldCR = await creditContract.getCreditRecord(creditHash);
                const oldDD = await creditContract.getDueDetail(creditHash);
                drawdownAmount = paymentAmount;

                const borrowerBalanceBefore = await mockTokenContract.balanceOf(
                    borrower.getAddress(),
                );
                const poolSafeBalanceBefore = await mockTokenContract.balanceOf(
                    poolSafeContract.address,
                );
                await expect(
                    creditContract
                        .connect(borrower)
                        .makePrincipalPaymentAndDrawdownWithReceivable(
                            borrower.getAddress(),
                            paymentTokenId,
                            paymentAmount,
                            { receivableAmount: paymentAmount, receivableId: drawdownTokenId },
                            paymentAmount,
                        ),
                )
                    .not.to.emit(creditContract, "PrincipalPaymentMadeWithReceivable")
                    .not.to.emit(creditContract, "DrawdownMadeWithReceivable");
                const borrowerBalanceAfter = await mockTokenContract.balanceOf(
                    borrower.getAddress(),
                );
                expect(borrowerBalanceBefore.sub(borrowerBalanceAfter)).to.equal(0);
                const poolSafeBalanceAfter = await mockTokenContract.balanceOf(
                    poolSafeContract.address,
                );
                expect(poolSafeBalanceAfter.sub(poolSafeBalanceBefore)).to.equal(0);

                const actualCR = await creditContract.getCreditRecord(creditHash);
                checkCreditRecordsMatch(actualCR, oldCR);

                const actualDD = await creditContract.getDueDetail(creditHash);
                checkDueDetailsMatch(actualDD, oldDD);
            });
        });

        describe("With credit approval and initial drawdown", function () {
            beforeEach(async function () {
                await loadFixture(approveBorrower);
                await loadFixture(initialDrawdown);
            });

            describe("When payment and drawdown amounts are the same", function () {
                it("Should allow payment and drawdown without affecting the pool balance", async function () {
                    const oldCR = await creditContract.getCreditRecord(creditHash);
                    const oldDD = await creditContract.getDueDetail(creditHash);
                    drawdownAmount = paymentAmount;

                    const borrowerBalanceBefore = await mockTokenContract.balanceOf(
                        borrower.getAddress(),
                    );
                    const poolSafeBalanceBefore = await mockTokenContract.balanceOf(
                        poolSafeContract.address,
                    );
                    await expect(
                        creditContract
                            .connect(borrower)
                            .makePrincipalPaymentAndDrawdownWithReceivable(
                                borrower.getAddress(),
                                paymentTokenId,
                                paymentAmount,
                                {
                                    receivableAmount: drawdownAmount,
                                    receivableId: drawdownTokenId,
                                },
                                drawdownAmount,
                            ),
                    )
                        .to.emit(creditContract, "PrincipalPaymentMadeWithReceivable")
                        .withArgs(
                            await borrower.getAddress(),
                            paymentTokenId,
                            paymentAmount,
                            await borrower.getAddress(),
                        )
                        .to.emit(creditContract, "DrawdownMadeWithReceivable")
                        .withArgs(
                            await borrower.getAddress(),
                            drawdownTokenId,
                            drawdownAmount,
                            drawdownAmount,
                            await borrower.getAddress(),
                        );
                    const borrowerBalanceAfter = await mockTokenContract.balanceOf(
                        borrower.getAddress(),
                    );
                    expect(borrowerBalanceBefore.sub(borrowerBalanceAfter)).to.equal(0);
                    const poolSafeBalanceAfter = await mockTokenContract.balanceOf(
                        poolSafeContract.address,
                    );
                    expect(poolSafeBalanceAfter.sub(poolSafeBalanceBefore)).to.equal(0);

                    const actualCR = await creditContract.getCreditRecord(creditHash);
                    checkCreditRecordsMatch(actualCR, oldCR);

                    const actualDD = await creditContract.getDueDetail(creditHash);
                    checkDueDetailsMatch(actualDD, oldDD);
                });
            });

            describe("When the payment amount is higher than the drawdown amount", function () {
                it("Should allow the borrower to make extra payment towards the pool", async function () {
                    const oldCR = await creditContract.getCreditRecord(creditHash);
                    const oldDD = await creditContract.getDueDetail(creditHash);
                    // The difference is payment and drawdown amount is the amount of principal due in the billing cycle.
                    const amountDiff = oldCR.nextDue.sub(oldCR.yieldDue);
                    drawdownAmount = paymentAmount.sub(amountDiff);

                    const borrowerBalanceBefore = await mockTokenContract.balanceOf(
                        borrower.getAddress(),
                    );
                    const poolSafeBalanceBefore = await mockTokenContract.balanceOf(
                        poolSafeContract.address,
                    );
                    await expect(
                        creditContract
                            .connect(borrower)
                            .makePrincipalPaymentAndDrawdownWithReceivable(
                                borrower.getAddress(),
                                paymentTokenId,
                                paymentAmount,
                                {
                                    receivableAmount: drawdownAmount,
                                    receivableId: drawdownTokenId,
                                },
                                drawdownAmount,
                            ),
                    )
                        .to.emit(creditContract, "PrincipalPaymentMadeWithReceivable")
                        .withArgs(
                            await borrower.getAddress(),
                            paymentTokenId,
                            paymentAmount,
                            await borrower.getAddress(),
                        )
                        .to.emit(creditContract, "DrawdownMadeWithReceivable")
                        .withArgs(
                            await borrower.getAddress(),
                            drawdownTokenId,
                            drawdownAmount,
                            drawdownAmount,
                            await borrower.getAddress(),
                        )
                        .to.emit(creditContract, "PrincipalPaymentMade")
                        .withArgs(
                            await borrower.getAddress(),
                            await borrower.getAddress(),
                            amountDiff,
                            oldCR.nextDueDate,
                            0,
                            oldCR.unbilledPrincipal,
                            amountDiff,
                            0,
                            await borrower.getAddress(),
                        );
                    const borrowerBalanceAfter = await mockTokenContract.balanceOf(
                        borrower.getAddress(),
                    );
                    expect(borrowerBalanceBefore.sub(borrowerBalanceAfter)).to.equal(amountDiff);
                    const poolSafeBalanceAfter = await mockTokenContract.balanceOf(
                        poolSafeContract.address,
                    );
                    expect(poolSafeBalanceAfter.sub(poolSafeBalanceBefore)).to.equal(amountDiff);

                    const actualCR = await creditContract.getCreditRecord(creditHash);
                    const expectedCR = {
                        ...oldCR,
                        ...{
                            nextDue: oldCR.yieldDue,
                        },
                    };
                    checkCreditRecordsMatch(actualCR, expectedCR);

                    const actualDD = await creditContract.getDueDetail(creditHash);
                    checkDueDetailsMatch(actualDD, oldDD);
                });
            });

            describe("When the payment amount is lower than the drawdown amount", function () {
                it("Should allow the borrower to drawdown additional capital from the pool", async function () {
                    const oldCR = await creditContract.getCreditRecord(creditHash);
                    const oldDD = await creditContract.getDueDetail(creditHash);
                    // The difference is payment and drawdown amount is the amount of principal due in the billing cycle.
                    const amountDiff = toToken(5_000);
                    drawdownAmount = paymentAmount.add(amountDiff);
                    const actionDate = await getFutureBlockTime(1);
                    const daysRemainingInPeriod = (
                        await calendarContract.getDaysDiff(actionDate, oldCR.nextDueDate)
                    ).toNumber();
                    const additionalYieldAccrued = calcYield(
                        amountDiff,
                        yieldInBps,
                        daysRemainingInPeriod,
                    );
                    const additionalPrincipalDue = calcPrincipalDueForPartialPeriod(
                        amountDiff,
                        principalRate,
                        daysRemainingInPeriod,
                        CONSTANTS.DAYS_IN_A_MONTH,
                    );

                    const borrowerBalanceBefore = await mockTokenContract.balanceOf(
                        borrower.getAddress(),
                    );
                    const poolSafeBalanceBefore = await mockTokenContract.balanceOf(
                        poolSafeContract.address,
                    );
                    await expect(
                        creditContract
                            .connect(borrower)
                            .makePrincipalPaymentAndDrawdownWithReceivable(
                                borrower.getAddress(),
                                paymentTokenId,
                                paymentAmount,
                                {
                                    receivableAmount: drawdownAmount,
                                    receivableId: drawdownTokenId,
                                },
                                drawdownAmount,
                            ),
                    )
                        .to.emit(creditContract, "PrincipalPaymentMadeWithReceivable")
                        .withArgs(
                            await borrower.getAddress(),
                            paymentTokenId,
                            paymentAmount,
                            await borrower.getAddress(),
                        )
                        .to.emit(creditContract, "DrawdownMadeWithReceivable")
                        .withArgs(
                            await borrower.getAddress(),
                            drawdownTokenId,
                            drawdownAmount,
                            drawdownAmount,
                            await borrower.getAddress(),
                        )
                        .to.emit(creditContract, "DrawdownMade")
                        .withArgs(await borrower.getAddress(), amountDiff, amountDiff);
                    const borrowerBalanceAfter = await mockTokenContract.balanceOf(
                        borrower.getAddress(),
                    );
                    expect(borrowerBalanceAfter.sub(borrowerBalanceBefore)).to.equal(amountDiff);
                    const poolSafeBalanceAfter = await mockTokenContract.balanceOf(
                        poolSafeContract.address,
                    );
                    expect(poolSafeBalanceBefore.sub(poolSafeBalanceAfter)).to.equal(amountDiff);

                    const actualCR = await creditContract.getCreditRecord(creditHash);
                    const expectedCR = {
                        ...oldCR,
                        ...{
                            unbilledPrincipal: oldCR.unbilledPrincipal
                                .add(amountDiff)
                                .sub(additionalPrincipalDue),
                            nextDue: oldCR.nextDue
                                .add(additionalYieldAccrued)
                                .add(additionalPrincipalDue),
                            yieldDue: oldCR.yieldDue.add(additionalYieldAccrued),
                        },
                    };
                    checkCreditRecordsMatch(actualCR, expectedCR);

                    const actualDD = await creditContract.getDueDetail(creditHash);
                    const expectedDD = {
                        ...oldDD,
                        ...{
                            accrued: oldDD.accrued.add(additionalYieldAccrued),
                        },
                    };
                    checkDueDetailsMatch(actualDD, expectedDD);
                });
            });

            it("Should not allow payment and drawdown when the protocol is paused or the pool is not on", async function () {
                await humaConfigContract.connect(protocolOwner).pause();
                await expect(
                    creditContract
                        .connect(borrower)
                        .makePrincipalPaymentAndDrawdownWithReceivable(
                            borrower.getAddress(),
                            paymentTokenId,
                            paymentAmount,
                            { receivableAmount: paymentAmount, receivableId: drawdownTokenId },
                            paymentAmount,
                        ),
                ).to.be.revertedWithCustomError(poolConfigContract, "protocolIsPaused");
                await humaConfigContract.connect(protocolOwner).unpause();

                await poolContract.connect(poolOwner).disablePool();
                await expect(
                    creditContract.makePrincipalPaymentAndDrawdownWithReceivable(
                        borrower.getAddress(),
                        paymentTokenId,
                        paymentAmount,
                        { receivableAmount: paymentAmount, receivableId: drawdownTokenId },
                        paymentAmount,
                    ),
                ).to.be.revertedWithCustomError(poolConfigContract, "poolIsNotOn");
                await poolContract.connect(poolOwner).enablePool();
            });

            it("Should not allow payment and drawdown by non-borrower", async function () {
                await expect(
                    creditContract
                        .connect(lender)
                        .makePrincipalPaymentAndDrawdownWithReceivable(
                            borrower.getAddress(),
                            paymentTokenId,
                            paymentAmount,
                            { receivableAmount: paymentAmount, receivableId: drawdownTokenId },
                            paymentAmount,
                        ),
                ).to.be.revertedWithCustomError(creditContract, "notBorrower");
            });

            it("Should not allow payment and drawdown if the payment amount is 0", async function () {
                await expect(
                    creditContract
                        .connect(borrower)
                        .makePrincipalPaymentAndDrawdownWithReceivable(
                            borrower.getAddress(),
                            paymentTokenId,
                            0,
                            { receivableAmount: paymentAmount, receivableId: drawdownTokenId },
                            paymentAmount,
                        ),
                ).to.be.revertedWithCustomError(creditContract, "zeroAmountProvided");
            });

            it("Should not allow payment and drawdown if the borrow amount is 0", async function () {
                await expect(
                    creditContract
                        .connect(borrower)
                        .makePrincipalPaymentAndDrawdownWithReceivable(
                            borrower.getAddress(),
                            paymentTokenId,
                            paymentAmount,
                            { receivableAmount: paymentAmount, receivableId: drawdownTokenId },
                            0,
                        ),
                ).to.be.revertedWithCustomError(creditContract, "zeroAmountProvided");
            });

            it("Should not allow payment and drawdown with 0 receivable ID for the payment receivable", async function () {
                await expect(
                    creditContract
                        .connect(borrower)
                        .makePrincipalPaymentAndDrawdownWithReceivable(
                            borrower.getAddress(),
                            paymentTokenId,
                            paymentAmount,
                            { receivableAmount: paymentAmount, receivableId: 0 },
                            paymentAmount,
                        ),
                ).to.be.revertedWithCustomError(creditContract, "zeroReceivableIdProvided");
            });

            it("Should not allow payment and drawdown if the receivable to be paid for wasn't transferred to the contract", async function () {
                // Create another receivable that wasn't used for drawdown, hence not transferred to the contract.
                await receivableContract
                    .connect(borrower)
                    .createReceivable(2, paymentAmount, paymentTokenId, "", "");
                const balance = await receivableContract.balanceOf(borrower.getAddress());
                expect(balance).to.equal(2);
                const tokenId2 = await receivableContract.tokenOfOwnerByIndex(
                    borrower.getAddress(),
                    1,
                );
                await receivableContract
                    .connect(borrower)
                    .approve(creditContract.address, tokenId2);
                await creditManagerContract
                    .connect(eaServiceAccount)
                    .approveReceivable(borrower.getAddress(), {
                        receivableAmount: paymentAmount,
                        receivableId: tokenId2,
                    });

                await expect(
                    creditContract
                        .connect(borrower)
                        .makePrincipalPaymentAndDrawdownWithReceivable(
                            borrower.getAddress(),
                            tokenId2,
                            paymentAmount,
                            { receivableAmount: paymentAmount, receivableId: drawdownTokenId },
                            paymentAmount,
                        ),
                ).to.be.revertedWithCustomError(creditContract, "notReceivableOwner");

                await receivableContract.connect(borrower).burn(tokenId2);
            });

            it("Should not allow payment and drawdown with 0 receivable amount", async function () {
                await expect(
                    creditContract
                        .connect(borrower)
                        .makePrincipalPaymentAndDrawdownWithReceivable(
                            borrower.getAddress(),
                            paymentTokenId,
                            paymentAmount,
                            { receivableAmount: 0, receivableId: drawdownTokenId },
                            paymentAmount,
                        ),
                ).to.be.revertedWithCustomError(creditContract, "zeroAmountProvided");
            });

            it("Should not allow payment and drawdown with 0 receivable ID for the drawdown receivable", async function () {
                await expect(
                    creditContract
                        .connect(borrower)
                        .makePrincipalPaymentAndDrawdownWithReceivable(
                            borrower.getAddress(),
                            paymentTokenId,
                            paymentAmount,
                            { receivableAmount: paymentAmount, receivableId: 0 },
                            paymentAmount,
                        ),
                ).to.be.revertedWithCustomError(creditContract, "zeroReceivableIdProvided");
            });

            it("Should not allow payment and drawdown if the borrower does not own the receivable that will be drawndown from", async function () {
                await receivableContract
                    .connect(lender)
                    .createReceivable(1, paymentAmount, drawdownReceivableMaturityDate, "", "");
                const balance = await receivableContract.balanceOf(borrower.getAddress());
                expect(balance).to.equal(1);
                const tokenId2 = await receivableContract.tokenOfOwnerByIndex(
                    lender.getAddress(),
                    0,
                );
                await receivableContract.connect(lender).approve(creditContract.address, tokenId2);

                await expect(
                    creditContract
                        .connect(borrower)
                        .makePrincipalPaymentAndDrawdownWithReceivable(
                            borrower.getAddress(),
                            paymentTokenId,
                            paymentAmount,
                            { receivableAmount: paymentAmount, receivableId: tokenId2 },
                            paymentAmount,
                        ),
                ).to.be.revertedWithCustomError(creditContract, "notReceivableOwner");

                await receivableContract.connect(lender).burn(tokenId2);
            });
        });
    });
});
