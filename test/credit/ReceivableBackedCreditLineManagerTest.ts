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
import { CONSTANTS, deployAndSetupPoolContracts, deployProtocolContracts } from "../BaseTest";
import { borrowerLevelCreditHash, toToken } from "../TestUtils";

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

describe("ReceivableBackedCreditLineManager Tests", function () {
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
            receivableContract,
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

    describe("approveReceivable", function () {
        let receivableAmount: BN, receivableId: BN;

        async function prepare() {
            receivableAmount = toToken(50_000);
            await receivableContract.connect(borrower).createReceivable(
                0, // currencyCode
                receivableAmount,
                100,
                "referenceId",
                "Test URI",
            );
            expect(await receivableContract.balanceOf(borrower.getAddress())).to.equal(1);
            receivableId = await receivableContract.tokenOfOwnerByIndex(borrower.getAddress(), 0);
        }

        beforeEach(async function () {
            await loadFixture(prepare);
        });

        describe("Without credit approval", function () {
            it("Should not approve receivables from the borrower", async function () {
                await expect(
                    creditManagerContract
                        .connect(eaServiceAccount)
                        .approveReceivable(borrower.getAddress(), receivableId),
                ).to.be.revertedWithCustomError(creditManagerContract, "notBorrower");
            });
        });

        describe("With credit approval", function () {
            const advanceRateInBps = 8000;
            let creditLimit: BN;
            let creditHash: string;

            async function approveBorrower() {
                const settings = await poolConfigContract.getPoolSettings();
                await poolConfigContract.connect(poolOwner).setPoolSettings({
                    ...settings,
                    ...{
                        advanceRateInBps: advanceRateInBps,
                    },
                });

                creditLimit = toToken(65_000);
                await creditManagerContract
                    .connect(eaServiceAccount)
                    .approveBorrower(
                        borrower.getAddress(),
                        creditLimit,
                        6,
                        1517,
                        toToken(0),
                        0,
                        true,
                    );

                creditHash = await borrowerLevelCreditHash(creditContract, borrower);
            }

            beforeEach(async function () {
                await loadFixture(approveBorrower);
            });

            it("Should approve receivables from the borrower", async function () {
                const incrementalCredit = receivableAmount
                    .mul(advanceRateInBps)
                    .div(CONSTANTS.BP_FACTOR);
                await expect(
                    creditManagerContract
                        .connect(eaServiceAccount)
                        .approveReceivable(borrower.getAddress(), receivableId),
                )
                    .to.emit(creditManagerContract, "ReceivableApproved")
                    .withArgs(
                        await borrower.getAddress(),
                        receivableId,
                        receivableAmount,
                        incrementalCredit,
                        incrementalCredit,
                    );
                // The same receivable can be approved twice w/o increasing the available credit.
                await expect(
                    creditManagerContract
                        .connect(eaServiceAccount)
                        .approveReceivable(borrower.getAddress(), receivableId),
                ).not.to.emit(creditManagerContract, "ReceivableApproved");
                const actualAvailableCredit =
                    await creditManagerContract.getAvailableCredit(creditHash);
                expect(actualAvailableCredit).to.equal(incrementalCredit);

                // Second approval should add onto the available credit.
                const receivableAmount2 = toToken(30_000);
                await receivableContract.connect(borrower).createReceivable(
                    0, // currencyCode
                    receivableAmount2,
                    100,
                    "referenceId2",
                    "Test URI",
                );
                const receivableId2 = await receivableContract.tokenOfOwnerByIndex(
                    borrower.getAddress(),
                    1,
                );
                const newIncrementalCredit = receivableAmount2
                    .mul(advanceRateInBps)
                    .div(CONSTANTS.BP_FACTOR);
                const expectedAvailableCredit = actualAvailableCredit.add(newIncrementalCredit);
                await expect(
                    creditManagerContract
                        .connect(eaServiceAccount)
                        .approveReceivable(borrower.getAddress(), receivableId2),
                )
                    .to.emit(creditManagerContract, "ReceivableApproved")
                    .withArgs(
                        await borrower.getAddress(),
                        receivableId2,
                        receivableAmount2,
                        newIncrementalCredit,
                        expectedAvailableCredit,
                    );
                const newActualAvailableCredit =
                    await creditManagerContract.getAvailableCredit(creditHash);
                expect(newActualAvailableCredit).to.equal(expectedAvailableCredit);

                // We should not allow the available credit to exceed the credit limit.
                const receivableAmount3 = toToken(30_000);
                await receivableContract.connect(borrower).createReceivable(
                    0, // currencyCode
                    receivableAmount3,
                    100,
                    "referenceId3",
                    "Test URI",
                );
                const receivableId3 = await receivableContract.tokenOfOwnerByIndex(
                    borrower.getAddress(),
                    2,
                );
                await expect(
                    creditManagerContract
                        .connect(eaServiceAccount)
                        .approveReceivable(borrower.getAddress(), receivableId3),
                ).to.be.revertedWithCustomError(creditManagerContract, "creditLineExceeded");
                // There should be no change to the available credit.
                expect(await creditManagerContract.getAvailableCredit(creditHash)).to.equal(
                    expectedAvailableCredit,
                );

                await receivableContract.connect(borrower).burn(receivableId2);
                await receivableContract.connect(borrower).burn(receivableId3);
                expect(await receivableContract.balanceOf(borrower.getAddress())).to.equal(1);
            });

            it("Should not approve the receivable if the protocol is paused or the pool is not on", async function () {
                await humaConfigContract.connect(protocolOwner).pause();
                await expect(
                    creditManagerContract
                        .connect(eaServiceAccount)
                        .approveReceivable(borrower.getAddress(), receivableId),
                ).to.be.revertedWithCustomError(poolConfigContract, "protocolIsPaused");
                await humaConfigContract.connect(protocolOwner).unpause();

                await poolContract.connect(poolOwner).disablePool();
                await expect(
                    creditManagerContract
                        .connect(eaServiceAccount)
                        .approveReceivable(borrower.getAddress(), receivableId),
                ).to.be.revertedWithCustomError(poolConfigContract, "poolIsNotOn");
                await poolContract.connect(poolOwner).enablePool();
            });

            it("Should not allow non-EA service account or non-credit contract to approve receivables", async function () {
                await expect(
                    creditManagerContract
                        .connect(borrower)
                        .approveReceivable(borrower.getAddress(), receivableId),
                ).to.be.revertedWithCustomError(creditManagerContract, "notAuthorizedCaller");
            });

            it("Should not approve a receivable that does not exist in the Receivable contract", async function () {
                // If there are n receivables, then receivable with ID n + 1 must not exist.
                const numReceivables = await receivableContract.totalSupply();
                await expect(
                    creditManagerContract
                        .connect(eaServiceAccount)
                        .approveReceivable(borrower.getAddress(), numReceivables.add(1)),
                ).to.be.revertedWithCustomError(creditManagerContract, "zeroReceivableAmount");
            });

            it("Should not approve a receivable with 0 amount", async function () {
                await receivableContract.connect(borrower).createReceivable(
                    0, // currencyCode
                    0,
                    100,
                    "referenceId4",
                    "Test URI",
                );
                const receivableId2 = await receivableContract.tokenOfOwnerByIndex(
                    borrower.getAddress(),
                    1,
                );

                await expect(
                    creditManagerContract
                        .connect(eaServiceAccount)
                        .approveReceivable(borrower.getAddress(), receivableId2),
                ).to.be.revertedWithCustomError(creditManagerContract, "zeroReceivableAmount");
            });

            it("Should not approve a receivable with 0 ID", async function () {
                await expect(
                    creditManagerContract
                        .connect(eaServiceAccount)
                        .approveReceivable(borrower.getAddress(), 0),
                ).to.be.revertedWithCustomError(creditManagerContract, "zeroReceivableIdProvided");
            });
        });
    });

    describe("validateReceivable", function () {
        it("Should reject receivables not owned by the borrower", async function () {
            await expect(
                creditManagerContract.validateReceivable(borrower.getAddress(), 1),
            ).to.be.revertedWithCustomError(creditManagerContract, "receivableIdMismatch");
        });
    });

    describe("decreaseCreditLimit", function () {
        let creditHash: string;
        let receivableAmount: BN;

        async function prepareForDecreaseCreditLimit() {
            receivableAmount = toToken(10_000);

            const settings = await poolConfigContract.getPoolSettings();
            await poolConfigContract.connect(poolOwner).setPoolSettings({
                ...settings,
                ...{
                    advanceRateInBps: CONSTANTS.BP_FACTOR,
                },
            });
            await creditManagerContract
                .connect(eaServiceAccount)
                .approveBorrower(
                    borrower.getAddress(),
                    toToken(100_000),
                    6,
                    1517,
                    toToken(0),
                    0,
                    true,
                );

            creditHash = await borrowerLevelCreditHash(creditContract, borrower);

            await receivableContract.connect(borrower).createReceivable(
                0, // currencyCode
                receivableAmount,
                100,
                "referenceId4",
                "Test URI",
            );
            const receivableId = await receivableContract.tokenOfOwnerByIndex(
                borrower.getAddress(),
                0,
            );
            await creditManagerContract
                .connect(eaServiceAccount)
                .approveReceivable(borrower.getAddress(), receivableId);
            const availableCredit = await creditManagerContract.getAvailableCredit(creditHash);
            expect(availableCredit).to.equal(receivableAmount);

            await poolConfigContract.connect(poolOwner).setCredit(defaultDeployer.getAddress());
            await creditManagerContract.connect(poolOwner).updatePoolConfigData();
        }

        beforeEach(async function () {
            await loadFixture(prepareForDecreaseCreditLimit);
        });

        it("Should allow the credit contract to decrease the credit limit", async function () {
            await creditManagerContract.decreaseCreditLimit(creditHash, receivableAmount);
            const availableCredit = await creditManagerContract.getAvailableCredit(creditHash);
            expect(availableCredit).to.equal(0);
        });

        it("Should not allow non-Credit contracts to decrease credit limit", async function () {
            await expect(
                creditManagerContract
                    .connect(borrower)
                    .decreaseCreditLimit(creditHash, receivableAmount),
            ).to.be.revertedWithCustomError(creditManagerContract, "notAuthorizedCaller");
        });

        it("Should not decrease the credit limit beyond what's available", async function () {
            await expect(
                creditManagerContract.decreaseCreditLimit(
                    creditHash,
                    receivableAmount.add(toToken(1)),
                ),
            ).to.be.revertedWithCustomError(creditManagerContract, "creditLineExceeded");
        });
    });
});
