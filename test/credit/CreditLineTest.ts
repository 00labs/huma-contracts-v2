import { ethers } from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import {
    deployAndSetupPoolContracts,
    deployProtocolContracts,
    checkCreditConfig,
    checkCreditRecord,
} from "../BaseTest";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { toToken } from "../TestUtils";
import {
    BaseCreditFeeManager,
    BasePnLManager,
    Calendar,
    CreditLine,
    EpochManager,
    EvaluationAgentNFT,
    HumaConfig,
    FirstLossCover,
    MockToken,
    PlatformFeeManager,
    Pool,
    PoolConfig,
    PoolVault,
    RiskAdjustedTranchesPolicy,
    TrancheVault,
} from "../../typechain-types";
import { AbiCoder } from "ethers";

let defaultDeployer: HardhatEthersSigner,
    protocolOwner: HardhatEthersSigner,
    treasury: HardhatEthersSigner,
    eaServiceAccount: HardhatEthersSigner,
    pdsServiceAccount: HardhatEthersSigner;
let poolOwner: HardhatEthersSigner,
    poolOwnerTreasury: HardhatEthersSigner,
    evaluationAgent: HardhatEthersSigner,
    poolOperator: HardhatEthersSigner;
let lender: HardhatEthersSigner, borrower: HardhatEthersSigner;

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
                        ethers.ZeroAddress,
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
            let creditLimit = poolSettings.maxCreditLine + 1n;

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
            const creditHash = ethers.keccak256(
                AbiCoder.defaultAbiCoder().encode(
                    ["address", "address"],
                    [await creditContract.getAddress(), borrower.address],
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
                1n,
                1217n,
                true,
                false,
                false,
                false,
            );

            let creditRecord = await creditContract.creditRecordMap(creditHash);
            checkCreditRecord(creditRecord, 0n, 0n, 0n, 0n, 0n, 0n, 1n, 3n);
        });
    });

    it("Should drawdown from a credit correctly", async function () {
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
            .approveBorrower(borrower.address, toToken(100_000), 1, 1217, toToken(100_000), true);

        await creditContract.connect(borrower).drawdown(borrower.address, toToken(10_000));
    });

    it("Should makePayment to a credit correctly", async function () {
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
            .approveBorrower(borrower.address, toToken(100_000), 1, 1217, toToken(100_000), true);

        await creditContract.connect(borrower).drawdown(borrower.address, toToken(10_000));

        await creditContract.connect(borrower).makePayment(borrower.address, toToken(100));
    });
});
