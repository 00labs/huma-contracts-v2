import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { BigNumber as BN } from "ethers";
import { ethers } from "hardhat";
import {
    Calendar,
    CreditDueManager,
    EpochManager,
    FirstLossCover,
    HumaConfig,
    MockNFT,
    MockToken,
    Pool,
    PoolConfig,
    PoolFeeManager,
    PoolSafe,
    ReceivableFactoringCredit,
    ReceivableFactoringCreditManager,
    RiskAdjustedTranchesPolicy,
    TrancheVault,
} from "../../../typechain-types";
import {
    CreditState,
    PayPeriodDuration,
    calcYield,
    calcYieldDue,
    checkCreditRecordsMatch,
    checkDueDetailsMatch,
    deployAndSetupPoolContracts,
    deployProtocolContracts,
    genDueDetail,
} from "../../BaseTest";
import {
    getFutureBlockTime,
    mineNextBlockWithTimestamp,
    receivableLevelCreditHash,
    setNextBlockTimestamp,
    toToken,
} from "../../TestUtils";
import { CONSTANTS } from "../../constants";

let defaultDeployer: SignerWithAddress,
    protocolOwner: SignerWithAddress,
    treasury: SignerWithAddress,
    sentinelServiceAccount: SignerWithAddress;
let poolOwner: SignerWithAddress,
    poolOwnerTreasury: SignerWithAddress,
    evaluationAgent: SignerWithAddress,
    poolOperator: SignerWithAddress;
let lender: SignerWithAddress, borrower: SignerWithAddress, payer: SignerWithAddress;

let humaConfigContract: HumaConfig, mockTokenContract: MockToken;
let poolConfigContract: PoolConfig,
    poolFeeManagerContract: PoolFeeManager,
    poolSafeContract: PoolSafe,
    calendarContract: Calendar,
    borrowerFirstLossCoverContract: FirstLossCover,
    adminFirstLossCoverContract: FirstLossCover,
    tranchesPolicyContract: RiskAdjustedTranchesPolicy,
    poolContract: Pool,
    epochManagerContract: EpochManager,
    seniorTrancheVaultContract: TrancheVault,
    juniorTrancheVaultContract: TrancheVault,
    creditContract: ReceivableFactoringCredit,
    creditDueManagerContract: CreditDueManager,
    creditManagerContract: ReceivableFactoringCreditManager,
    nftContract: MockNFT;

describe("ReceivableFactoringCredit Tests", function () {
    before(async function () {
        [
            defaultDeployer,
            protocolOwner,
            treasury,
            sentinelServiceAccount,
            poolOwner,
            poolOwnerTreasury,
            evaluationAgent,
            poolOperator,
            lender,
            borrower,
            payer,
        ] = await ethers.getSigners();
    });

    async function prepare() {
        [humaConfigContract, mockTokenContract] = await deployProtocolContracts(
            protocolOwner,
            treasury,
            sentinelServiceAccount,
            poolOwner,
        );

        [
            poolConfigContract,
            poolFeeManagerContract,
            poolSafeContract,
            calendarContract,
            borrowerFirstLossCoverContract,
            adminFirstLossCoverContract,
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
            "RiskAdjustedTranchesPolicy",
            defaultDeployer,
            poolOwner,
            "ReceivableFactoringCredit",
            "ReceivableFactoringCreditManager",
            evaluationAgent,
            treasury,
            poolOwnerTreasury,
            poolOperator,
            [lender, borrower, payer],
        );

        const MockNFT = await ethers.getContractFactory("MockNFT");
        nftContract = await MockNFT.deploy();
        await nftContract.deployed();

        await nftContract.initialize(mockTokenContract.address, poolSafeContract.address);
        await poolConfigContract.connect(poolOwner).setReceivableAsset(nftContract.address);
        await creditManagerContract.connect(poolOwner).addPayer(payer.getAddress());

        await borrowerFirstLossCoverContract.connect(poolOwner).addCoverProvider(borrower.address);
        await mockTokenContract
            .connect(borrower)
            .approve(borrowerFirstLossCoverContract.address, ethers.constants.MaxUint256);

        await juniorTrancheVaultContract.connect(lender).deposit(toToken(10_000_000));
    }

    beforeEach(async function () {
        await loadFixture(prepare);
    });

    describe("getNextBillRefreshDate and getDueInfo", function () {
        const yieldInBps = 1217,
            principalRate = 100,
            lateFeeBps = 2400;
        const latePaymentGracePeriodInDays = 5;
        let creditLimit: BN, borrowAmount: BN, tokenId: BN;
        let creditHash: string;

        async function prepareForGetDueInfo() {
            let settings = await poolConfigContract.getPoolSettings();
            await poolConfigContract.connect(poolOwner).setPoolSettings({
                ...settings,
                ...{ latePaymentGracePeriodInDays: latePaymentGracePeriodInDays },
            });
            await poolConfigContract.connect(poolOwner).setFeeStructure({
                yieldInBps,
                minPrincipalRateInBps: principalRate,
                lateFeeBps,
            });

            await nftContract.mintNFT(borrower.getAddress(), "");
            tokenId = await nftContract.tokenOfOwnerByIndex(borrower.getAddress(), 0);

            creditLimit = toToken(100_000);
            borrowAmount = toToken(15_000);
            creditHash = await receivableLevelCreditHash(creditContract, nftContract, tokenId);

            await creditManagerContract
                .connect(evaluationAgent)
                .approveReceivable(
                    borrower.getAddress(),
                    { receivableAmount: creditLimit, receivableId: tokenId },
                    creditLimit,
                    1,
                    yieldInBps,
                );
            await nftContract.connect(borrower).approve(creditContract.address, tokenId);
        }

        beforeEach(async function () {
            await loadFixture(prepareForGetDueInfo);
        });

        it("Should return the latest bill and refresh date for the credit", async function () {
            await creditContract
                .connect(borrower)
                .drawdownWithReceivable(borrower.getAddress(), tokenId, borrowAmount);

            const oldCR = await creditContract["getCreditRecord(bytes32)"](creditHash);
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
            const [accruedYieldDue] = calcYieldDue(cc, borrowAmount, CONSTANTS.DAYS_IN_A_MONTH);
            const tomorrow = await calendarContract.getStartOfNextDay(viewTime);
            const lateFee = calcYield(borrowAmount, lateFeeBps, latePaymentGracePeriodInDays + 1);
            expect(lateFee).to.be.gt(0);

            const refreshDate = await creditContract.getNextBillRefreshDate(tokenId);
            expect(refreshDate).to.equal(latePaymentDeadline);
            const [actualCR, actualDD] = await creditContract.getDueInfo(tokenId);
            const expectedCR = {
                unbilledPrincipal: 0,
                nextDueDate,
                nextDue: accruedYieldDue,
                yieldDue: accruedYieldDue,
                totalPastDue: borrowAmount.add(oldCR.yieldDue).add(lateFee),
                missedPeriods: 1,
                remainingPeriods: 0,
                state: CreditState.Delayed,
            };
            checkCreditRecordsMatch(actualCR, expectedCR);
            const expectedDD = genDueDetail({
                lateFeeUpdatedDate: tomorrow,
                lateFee: lateFee,
                yieldPastDue: oldCR.yieldDue,
                principalPastDue: borrowAmount,
                accrued: accruedYieldDue,
            });
            checkDueDetailsMatch(actualDD, expectedDD);
        });
    });

    describe("drawdownWithReceivable", function () {
        const yieldInBps = 1217,
            principalRate = 100,
            lateFeeBps = 2400;
        const numOfPeriods = 1,
            latePaymentGracePeriodInDays = 5;
        let creditLimit: BN, borrowAmount: BN, tokenId: BN;
        let creditHash: string;

        async function prepareForDrawdown() {
            const settings = await poolConfigContract.getPoolSettings();
            await poolConfigContract.connect(poolOwner).setPoolSettings({
                ...settings,
                ...{
                    payPeriodDuration: PayPeriodDuration.Monthly,
                    latePaymentGracePeriodInDays: latePaymentGracePeriodInDays,
                },
            });
            await poolConfigContract.connect(poolOwner).setFeeStructure({
                yieldInBps,
                minPrincipalRateInBps: principalRate,
                lateFeeBps,
            });

            await nftContract.mintNFT(borrower.address, "");
            tokenId = await nftContract.tokenOfOwnerByIndex(borrower.address, 0);
            await nftContract.connect(borrower).approve(creditContract.address, tokenId);

            creditHash = await receivableLevelCreditHash(creditContract, nftContract, tokenId);
            borrowAmount = toToken(15_000);
            creditLimit = borrowAmount.mul(5);
        }

        async function approveCredit() {
            await creditManagerContract
                .connect(evaluationAgent)
                .approveReceivable(
                    borrower.address,
                    { receivableAmount: creditLimit, receivableId: tokenId },
                    creditLimit,
                    numOfPeriods,
                    yieldInBps,
                );
        }

        beforeEach(async function () {
            await loadFixture(prepareForDrawdown);
        });

        describe("Without credit approval", function () {
            it("Should not allow drawdown by the borrower", async function () {
                await expect(
                    creditContract
                        .connect(borrower)
                        .drawdownWithReceivable(borrower.getAddress(), tokenId, borrowAmount),
                ).to.be.revertedWithCustomError(creditManagerContract, "BorrowerRequired");
            });
        });

        describe("With credit approval", function () {
            beforeEach(async function () {
                await loadFixture(approveCredit);
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
                const nextDue = accruedYieldDue.add(borrowAmount);

                const borrowerOldBalance = await mockTokenContract.balanceOf(
                    borrower.getAddress(),
                );
                await expect(
                    creditContract
                        .connect(borrower)
                        .drawdownWithReceivable(borrower.getAddress(), tokenId, borrowAmount),
                )
                    .to.emit(creditContract, "DrawdownMade")
                    .withArgs(await borrower.getAddress(), borrowAmount, netBorrowAmount)
                    .to.emit(creditContract, "DrawdownMadeWithReceivable")
                    .withArgs(
                        await borrower.getAddress(),
                        tokenId,
                        borrowAmount,
                        await borrower.getAddress(),
                    )
                    .to.emit(creditContract, "BillRefreshed")
                    .withArgs(creditHash, nextDueDate, nextDue);
                const borrowerNewBalance = await mockTokenContract.balanceOf(
                    borrower.getAddress(),
                );
                expect(borrowerNewBalance.sub(borrowerOldBalance)).to.equal(netBorrowAmount);

                const actualCR = await creditContract["getCreditRecord(uint256)"](tokenId);
                const expectedCR = {
                    unbilledPrincipal: 0,
                    nextDueDate,
                    nextDue,
                    yieldDue: accruedYieldDue,
                    totalPastDue: 0,
                    missedPeriods: 0,
                    remainingPeriods: numOfPeriods - 1,
                    state: CreditState.GoodStanding,
                };
                checkCreditRecordsMatch(actualCR, expectedCR);

                const actualDD = await creditContract.getDueDetail(creditHash);
                checkDueDetailsMatch(
                    actualDD,
                    genDueDetail({ accrued: accruedYieldDue, committed: committedYieldDue }),
                );
            });

            it("Should not allow drawdown when the protocol is paused or pool is not on", async function () {
                await humaConfigContract.connect(protocolOwner).pause();
                await expect(
                    creditContract
                        .connect(borrower)
                        .drawdownWithReceivable(borrower.getAddress(), tokenId, borrowAmount),
                ).to.be.revertedWithCustomError(poolConfigContract, "ProtocolIsPaused");
                await humaConfigContract.connect(protocolOwner).unpause();

                await poolContract.connect(poolOwner).disablePool();
                await expect(
                    creditContract
                        .connect(borrower)
                        .drawdownWithReceivable(borrower.getAddress(), tokenId, borrowAmount),
                ).to.be.revertedWithCustomError(poolConfigContract, "PoolIsNotOn");
                await poolContract.connect(poolOwner).enablePool();
            });

            it("Should not allow drawdown by non-borrowers", async function () {
                await expect(
                    creditContract
                        .connect(lender)
                        .drawdownWithReceivable(borrower.getAddress(), tokenId, borrowAmount),
                ).to.be.revertedWithCustomError(creditContract, "BorrowerRequired");
            });

            it("Should not allow drawdown with 0 receivable ID", async function () {
                await expect(
                    creditContract
                        .connect(borrower)
                        .drawdownWithReceivable(borrower.getAddress(), 0, borrowAmount),
                ).to.be.revertedWithCustomError(creditContract, "ZeroReceivableIdProvided");
            });

            it("Should not allow drawdown if the borrower does not own the receivable", async function () {
                await nftContract.connect(lender).mintNFT(lender.getAddress(), "");
                const tokenId2 = await nftContract.tokenOfOwnerByIndex(lender.getAddress(), 0);
                await nftContract.connect(lender).approve(creditContract.address, tokenId2);

                await expect(
                    creditContract
                        .connect(borrower)
                        .drawdownWithReceivable(borrower.getAddress(), tokenId2, borrowAmount),
                ).to.be.revertedWithCustomError(creditContract, "ReceivableOwnerRequired");

                await nftContract.connect(lender).burn(tokenId2);
            });
        });
    });

    describe("makePaymentWithReceivable", function () {
        const yieldInBps = 1217,
            principalRate = 100,
            lateFeeBps = 2400;
        const numOfPeriods = 1,
            latePaymentGracePeriodInDays = 5;
        let creditLimit: BN, borrowAmount: BN, tokenId: BN;
        let creditHash: string;

        async function prepareForMakePayment() {
            const settings = await poolConfigContract.getPoolSettings();
            await poolConfigContract.connect(poolOwner).setPoolSettings({
                ...settings,
                ...{
                    latePaymentGracePeriodInDays: latePaymentGracePeriodInDays,
                },
            });
            await poolConfigContract.connect(poolOwner).setFeeStructure({
                yieldInBps,
                minPrincipalRateInBps: principalRate,
                lateFeeBps,
            });

            await nftContract.mintNFT(borrower.address, "");
            tokenId = await nftContract.tokenOfOwnerByIndex(borrower.address, 0);
            await nftContract.connect(borrower).approve(creditContract.address, tokenId);

            creditHash = await receivableLevelCreditHash(creditContract, nftContract, tokenId);
            borrowAmount = toToken(15_000);
            creditLimit = borrowAmount.mul(5);
        }

        async function approveCreditAndDrawdown() {
            await creditManagerContract
                .connect(evaluationAgent)
                .approveReceivable(
                    borrower.address,
                    { receivableAmount: creditLimit, receivableId: tokenId },
                    creditLimit,
                    numOfPeriods,
                    yieldInBps,
                );
            await creditContract
                .connect(borrower)
                .drawdownWithReceivable(borrower.getAddress(), tokenId, borrowAmount);
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
                ).to.be.revertedWithCustomError(creditManagerContract, "BorrowerRequired");
            });

            it("Should not allow payment if the receivable wasn't transferred to the contract", async function () {
                // Create another receivable that wasn't used for drawdown, hence not transferred to the contract.
                await nftContract.connect(borrower).mintNFT(borrower.getAddress(), "");
                const balance = await nftContract.balanceOf(borrower.getAddress());
                expect(balance).to.equal(2);
                const tokenId2 = await nftContract.tokenOfOwnerByIndex(borrower.getAddress(), 1);
                await nftContract.connect(borrower).approve(creditContract.address, tokenId2);
                await creditManagerContract
                    .connect(evaluationAgent)
                    .approveReceivable(
                        borrower.address,
                        { receivableAmount: creditLimit, receivableId: tokenId2 },
                        creditLimit,
                        numOfPeriods,
                        yieldInBps,
                    );

                await expect(
                    creditContract
                        .connect(borrower)
                        .makePaymentWithReceivable(borrower.getAddress(), tokenId2, borrowAmount),
                ).to.be.revertedWithCustomError(creditContract, "ReceivableOwnerRequired");

                await nftContract.connect(borrower).burn(tokenId2);
            });
        });

        describe("With credit approval", function () {
            beforeEach(async function () {
                await loadFixture(approveCreditAndDrawdown);
            });

            it("Should allow the borrower to make payment", async function () {
                const oldCR = await creditContract["getCreditRecord(uint256)"](tokenId);
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

                const actualCR = await creditContract["getCreditRecord(uint256)"](tokenId);
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
                ).to.be.revertedWithCustomError(poolConfigContract, "ProtocolIsPaused");
                await humaConfigContract.connect(protocolOwner).unpause();

                await poolContract.connect(poolOwner).disablePool();
                await expect(
                    creditContract
                        .connect(borrower)
                        .makePaymentWithReceivable(borrower.getAddress(), tokenId, borrowAmount),
                ).to.be.revertedWithCustomError(poolConfigContract, "PoolIsNotOn");
                await poolContract.connect(poolOwner).enablePool();
            });

            it("Should not allow payment by non-payer", async function () {
                await expect(
                    creditContract
                        .connect(lender)
                        .makePaymentWithReceivable(borrower.getAddress(), tokenId, borrowAmount),
                ).to.be.revertedWithCustomError(creditContract, "BorrowerRequired");
            });

            it("Should not allow payment with 0 receivable ID", async function () {
                await expect(
                    creditContract
                        .connect(borrower)
                        .makePaymentWithReceivable(borrower.getAddress(), 0, borrowAmount),
                ).to.be.revertedWithCustomError(creditContract, "ZeroReceivableIdProvided");
            });
        });
    });

    describe("makePaymentWithReceivableByPayer", function () {
        const yieldInBps = 1217,
            principalRate = 100,
            lateFeeBps = 2400;
        const numOfPeriods = 1,
            latePaymentGracePeriodInDays = 5;
        let creditLimit: BN, borrowAmount: BN, tokenId: BN;
        let creditHash: string;

        async function prepareForMakePayment() {
            const settings = await poolConfigContract.getPoolSettings();
            await poolConfigContract.connect(poolOwner).setPoolSettings({
                ...settings,
                ...{
                    latePaymentGracePeriodInDays: latePaymentGracePeriodInDays,
                },
            });
            await poolConfigContract.connect(poolOwner).setFeeStructure({
                yieldInBps,
                minPrincipalRateInBps: principalRate,
                lateFeeBps,
            });

            await nftContract.mintNFT(borrower.address, "");
            tokenId = await nftContract.tokenOfOwnerByIndex(borrower.address, 0);
            await nftContract.connect(borrower).approve(creditContract.address, tokenId);

            creditHash = await receivableLevelCreditHash(creditContract, nftContract, tokenId);
            borrowAmount = toToken(15_000);
            creditLimit = borrowAmount.mul(5);
        }

        async function approveCreditAndDrawdown() {
            await creditManagerContract
                .connect(evaluationAgent)
                .approveReceivable(
                    borrower.address,
                    { receivableAmount: creditLimit, receivableId: tokenId },
                    creditLimit,
                    numOfPeriods,
                    yieldInBps,
                );
            await creditContract
                .connect(borrower)
                .drawdownWithReceivable(borrower.getAddress(), tokenId, borrowAmount);
        }

        beforeEach(async function () {
            await loadFixture(prepareForMakePayment);
        });

        describe("Without credit approval", function () {
            it("Should not allow payment if the receivable wasn't transferred to the contract", async function () {
                // Create another receivable that wasn't used for drawdown, hence not transferred to the contract.
                await nftContract.connect(borrower).mintNFT(borrower.getAddress(), "");
                const balance = await nftContract.balanceOf(borrower.getAddress());
                expect(balance).to.equal(2);
                const tokenId2 = await nftContract.tokenOfOwnerByIndex(borrower.getAddress(), 1);
                await nftContract.connect(borrower).approve(creditContract.address, tokenId2);
                await creditManagerContract
                    .connect(evaluationAgent)
                    .approveReceivable(
                        borrower.address,
                        { receivableAmount: creditLimit, receivableId: tokenId2 },
                        creditLimit,
                        numOfPeriods,
                        yieldInBps,
                    );

                await expect(
                    creditContract
                        .connect(payer)
                        .makePaymentWithReceivableByPayer(tokenId2, borrowAmount),
                ).to.be.revertedWithCustomError(creditContract, "ReceivableOwnerRequired");

                await nftContract.connect(borrower).burn(tokenId2);
            });
        });

        describe("With credit approval", function () {
            beforeEach(async function () {
                await loadFixture(approveCreditAndDrawdown);
            });

            it("Should allow the payer to make payment", async function () {
                const oldCR = await creditContract["getCreditRecord(uint256)"](tokenId);
                const oldDD = await creditContract.getDueDetail(creditHash);
                const paymentAmount = oldCR.yieldDue;

                await expect(
                    creditContract
                        .connect(payer)
                        .makePaymentWithReceivableByPayer(tokenId, paymentAmount),
                )
                    .to.emit(creditContract, "PaymentMade")
                    .withArgs(
                        await borrower.getAddress(),
                        await payer.getAddress(),
                        paymentAmount,
                        oldCR.yieldDue,
                        0,
                        0,
                        0,
                        0,
                        0,
                        await payer.getAddress(),
                    )
                    .to.emit(creditContract, "PaymentMadeWithReceivable")
                    .withArgs(
                        await borrower.getAddress(),
                        tokenId,
                        paymentAmount,
                        await payer.getAddress(),
                    )
                    .to.not.emit(creditContract, "ExtraFundsDisbursed");

                const actualCR = await creditContract["getCreditRecord(uint256)"](tokenId);
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

            it("Should allow the payer to make payment and disburse unused funds back to the borrower", async function () {
                const extraPaymentAmount = toToken(1_000);
                const oldCR = await creditContract["getCreditRecord(uint256)"](tokenId);
                const oldDD = await creditContract.getDueDetail(creditHash);
                const paymentAmount = oldCR.nextDue
                    .add(oldCR.unbilledPrincipal)
                    .add(extraPaymentAmount);

                const oldBorrowerBalance = await mockTokenContract.balanceOf(
                    borrower.getAddress(),
                );
                await expect(
                    creditContract
                        .connect(payer)
                        .makePaymentWithReceivableByPayer(tokenId, paymentAmount),
                )
                    .to.emit(creditContract, "PaymentMade")
                    .withArgs(
                        await borrower.getAddress(),
                        await payer.getAddress(),
                        paymentAmount.sub(extraPaymentAmount),
                        oldCR.yieldDue,
                        oldCR.nextDue.sub(oldCR.yieldDue),
                        oldCR.unbilledPrincipal,
                        0,
                        0,
                        0,
                        await payer.getAddress(),
                    )
                    .to.emit(creditContract, "PaymentMadeWithReceivable")
                    .withArgs(
                        await borrower.getAddress(),
                        tokenId,
                        paymentAmount,
                        await payer.getAddress(),
                    )
                    .to.emit(creditContract, "ExtraFundsDisbursed")
                    .withArgs(await borrower.getAddress(), extraPaymentAmount);
                const newBorrowerBalance = await mockTokenContract.balanceOf(
                    borrower.getAddress(),
                );

                expect(newBorrowerBalance).to.equal(oldBorrowerBalance.add(extraPaymentAmount));

                const actualCR = await creditContract["getCreditRecord(uint256)"](tokenId);
                const expectedCR = {
                    ...oldCR,
                    ...{
                        nextDue: 0,
                        yieldDue: 0,
                        state: CreditState.Deleted,
                    },
                };
                checkCreditRecordsMatch(actualCR, expectedCR);

                const actualDD = await creditContract.getDueDetail(creditHash);
                const expectedDD = {
                    ...oldDD,
                    ...{
                        paid: oldCR.yieldDue,
                    },
                };
                checkDueDetailsMatch(actualDD, expectedDD);
            });

            it("Should not allow payment when the protocol is paused or the pool is not on", async function () {
                await humaConfigContract.connect(protocolOwner).pause();
                await expect(
                    creditContract
                        .connect(payer)
                        .makePaymentWithReceivableByPayer(tokenId, borrowAmount),
                ).to.be.revertedWithCustomError(poolConfigContract, "ProtocolIsPaused");
                await humaConfigContract.connect(protocolOwner).unpause();

                await poolContract.connect(poolOwner).disablePool();
                await expect(
                    creditContract
                        .connect(payer)
                        .makePaymentWithReceivableByPayer(tokenId, borrowAmount),
                ).to.be.revertedWithCustomError(poolConfigContract, "PoolIsNotOn");
                await poolContract.connect(poolOwner).enablePool();
            });

            it("Should not allow payment by non-payer", async function () {
                await expect(
                    creditContract
                        .connect(borrower)
                        .makePaymentWithReceivableByPayer(tokenId, borrowAmount),
                ).to.be.revertedWithCustomError(creditManagerContract, "PayerRequired");
            });

            it("Should not allow payment with 0 receivable ID", async function () {
                await expect(
                    creditContract
                        .connect(payer)
                        .makePaymentWithReceivableByPayer(0, borrowAmount),
                ).to.be.revertedWithCustomError(creditContract, "ZeroReceivableIdProvided");
            });
        });
    });
});
