import { ethers } from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import {
    deployAndSetupPoolContracts,
    deployPoolContracts,
    deployProtocolContracts,
} from "./BaseTest";
import { toToken } from "./TestUtils";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import {
    BaseCreditFeeManager,
    BasePnLManager,
    Calendar,
    EpochManager,
    EvaluationAgentNFT,
    HumaConfig,
    LossCoverer,
    MockPoolCredit,
    MockToken,
    PlatformFeeManager,
    Pool,
    PoolConfig,
    PoolVault,
    RiskAdjustedTranchesPolicy,
    TrancheVault,
} from "../typechain-types";

let defaultDeployer: HardhatEthersSigner,
    protocolOwner: HardhatEthersSigner,
    treasury: HardhatEthersSigner,
    eaServiceAccount: HardhatEthersSigner,
    pdsServiceAccount: HardhatEthersSigner;
let poolOwner: HardhatEthersSigner,
    poolOwnerTreasury: HardhatEthersSigner,
    evaluationAgent: HardhatEthersSigner,
    poolOperator: HardhatEthersSigner;
let lender: HardhatEthersSigner;

let eaNFTContract: EvaluationAgentNFT,
    humaConfigContract: HumaConfig,
    mockTokenContract: MockToken;
let poolConfigContract: PoolConfig,
    platformFeeManagerContract: PlatformFeeManager,
    poolVaultContract: PoolVault,
    calendarContract: Calendar,
    poolOwnerAndEAFirstLossCoverContract: LossCoverer,
    tranchesPolicyContract: RiskAdjustedTranchesPolicy,
    poolContract: Pool,
    epochManagerContract: EpochManager,
    seniorTrancheVaultContract: TrancheVault,
    juniorTrancheVaultContract: TrancheVault,
    creditContract: MockPoolCredit,
    creditFeeManagerContract: BaseCreditFeeManager,
    creditPnlManagerContract: BasePnLManager;

describe("Receivable Test", function () {
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
        ] = await ethers.getSigners();
    });

    describe("Tests before Pool is enabled", function () {
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
            ] = await deployPoolContracts(
                humaConfigContract,
                mockTokenContract,
                "RiskAdjustedTranchesPolicy",
                defaultDeployer,
                poolOwner,
                "MockPoolCredit",
            );
        }

        beforeEach(async function () {
            await loadFixture(prepare);
        });

        it("Should not allow non-poolOwner and non-protocolAdmin to enable a pool", async function () {
            await expect(poolContract.enablePool()).to.be.revertedWithCustomError(
                poolConfigContract,
                "permissionDeniedNotAdmin",
            );
        });

        it("Should not enable a pool while no enough first loss cover", async function () {
            await expect(
                poolContract.connect(protocolOwner).enablePool(),
            ).to.be.revertedWithCustomError(poolOwnerAndEAFirstLossCoverContract, "notOperator");

            await poolConfigContract.connect(poolOwner).setPoolLiquidityCap(toToken(1_000_000));
            await poolConfigContract
                .connect(poolOwner)
                .setPoolOwnerTreasury(poolOwnerTreasury.address);
            await poolOwnerAndEAFirstLossCoverContract
                .connect(poolOwner)
                .setOperator(poolOwnerTreasury.address, {
                    poolCapCoverageInBps: 1000,
                    poolValueCoverageInBps: 1000,
                });

            await expect(
                poolContract.connect(protocolOwner).enablePool(),
            ).to.be.revertedWithCustomError(poolConfigContract, "lessThanRequiredCover");

            await mockTokenContract
                .connect(poolOwnerTreasury)
                .approve(poolOwnerAndEAFirstLossCoverContract.getAddress(), ethers.MaxUint256);
            await mockTokenContract.mint(poolOwnerTreasury.address, toToken(10_000_000));
            await poolOwnerAndEAFirstLossCoverContract
                .connect(poolOwnerTreasury)
                .addCover(toToken(200_000));

            await expect(
                poolContract.connect(protocolOwner).enablePool(),
            ).to.be.revertedWithCustomError(poolOwnerAndEAFirstLossCoverContract, "notOperator");

            const tx = await eaNFTContract.mintNFT(evaluationAgent.getAddress());
            await tx.wait();
            const eventFilter = eaNFTContract.filters.NFTGenerated;
            const nftGeneratedEvents = await eaNFTContract.queryFilter(eventFilter);
            const eaNFTTokenId = nftGeneratedEvents[0].args.tokenId;
            await poolConfigContract
                .connect(poolOwner)
                .setEvaluationAgent(eaNFTTokenId, evaluationAgent.address);
            await poolOwnerAndEAFirstLossCoverContract
                .connect(poolOwner)
                .setOperator(evaluationAgent.address, {
                    poolCapCoverageInBps: 1000,
                    poolValueCoverageInBps: 1000,
                });

            await expect(
                poolContract.connect(protocolOwner).enablePool(),
            ).to.be.revertedWithCustomError(poolConfigContract, "lessThanRequiredCover");

            await mockTokenContract
                .connect(evaluationAgent)
                .approve(poolOwnerAndEAFirstLossCoverContract.getAddress(), ethers.MaxUint256);
            await mockTokenContract.mint(evaluationAgent.address, toToken(10_000_000));
            await poolOwnerAndEAFirstLossCoverContract
                .connect(evaluationAgent)
                .addCover(toToken(50_000));

            await expect(
                poolContract.connect(protocolOwner).enablePool(),
            ).to.be.revertedWithCustomError(poolConfigContract, "lessThanRequiredCover");
        });

        it("Should enable a pool", async function () {
            await poolConfigContract.connect(poolOwner).setPoolLiquidityCap(toToken(1_000_000));
            await poolConfigContract
                .connect(poolOwner)
                .setPoolOwnerTreasury(poolOwnerTreasury.address);
            await poolOwnerAndEAFirstLossCoverContract
                .connect(poolOwner)
                .setOperator(poolOwnerTreasury.address, {
                    poolCapCoverageInBps: 1000,
                    poolValueCoverageInBps: 1000,
                });

            await mockTokenContract
                .connect(poolOwnerTreasury)
                .approve(poolOwnerAndEAFirstLossCoverContract.getAddress(), ethers.MaxUint256);
            await mockTokenContract.mint(poolOwnerTreasury.address, toToken(10_000_000));
            await poolOwnerAndEAFirstLossCoverContract
                .connect(poolOwnerTreasury)
                .addCover(toToken(200_000));

            const tx = await eaNFTContract.mintNFT(evaluationAgent.getAddress());
            await tx.wait();
            const eventFilter = eaNFTContract.filters.NFTGenerated;
            const nftGeneratedEvents = await eaNFTContract.queryFilter(eventFilter);
            const eaNFTTokenId = nftGeneratedEvents[0].args.tokenId;
            await poolConfigContract
                .connect(poolOwner)
                .setEvaluationAgent(eaNFTTokenId, evaluationAgent.address);
            await poolOwnerAndEAFirstLossCoverContract
                .connect(poolOwner)
                .setOperator(evaluationAgent.address, {
                    poolCapCoverageInBps: 1000,
                    poolValueCoverageInBps: 1000,
                });

            await mockTokenContract
                .connect(evaluationAgent)
                .approve(poolOwnerAndEAFirstLossCoverContract.getAddress(), ethers.MaxUint256);
            await mockTokenContract.mint(evaluationAgent.address, toToken(10_000_000));
            await poolOwnerAndEAFirstLossCoverContract
                .connect(evaluationAgent)
                .addCover(toToken(200_000));

            await expect(poolContract.connect(protocolOwner).enablePool())
                .to.emit(poolContract, "PoolEnabled")
                .withArgs(protocolOwner.address);
        });
    });

    describe("Tests after Pool is enabled", function () {
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
                "MockPoolCredit",
                evaluationAgent,
                poolOwnerTreasury,
                poolOperator,
                [lender],
            );
        }

        beforeEach(async function () {
            await loadFixture(prepare);
        });

        it("Should not allow non-Operator to disable a pool", async function () {
            await expect(poolContract.disablePool()).to.be.revertedWithCustomError(
                poolConfigContract,
                "poolOperatorRequired",
            );
        });

        it("Should disable a pool", async function () {
            await expect(poolContract.connect(poolOperator).disablePool())
                .to.emit(poolContract, "PoolDisabled")
                .withArgs(poolOperator.address);
        });
    });
});
