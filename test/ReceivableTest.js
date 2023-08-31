const {ethers} = require("hardhat");
const {expect} = require("chai");
const {BigNumber: BN} = require("ethers");
const {loadFixture} = require("@nomicfoundation/hardhat-network-helpers");
const {
    deployProtocolContracts,
    deployPoolContracts,
    deployAndSetupPoolContracts,
} = require("./BaseTest");
const {toToken} = require("./TestUtils");

let defaultDeployer, protocolOwner, treasury, eaServiceAccount, pdsServiceAccount;
let poolOwner, poolOwnerTreasury, evaluationAgent, poolOperator;
let lender;

let eaNFTContract, humaConfigContract, mockTokenContract;
let poolConfigContract,
    platformFeeManagerContract,
    poolVaultContract,
    calendarContract,
    poolOwnerAndEAlossCovererContract,
    tranchesPolicyContract,
    poolContract,
    epochManagerContract,
    seniorTrancheVaultContract,
    juniorTrancheVaultContract,
    creditContract;

describe.skip("Receivable Test", function () {
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
                poolOwner
            );

            [
                poolConfigContract,
                platformFeeManagerContract,
                poolVaultContract,
                calendarContract,
                poolOwnerAndEAlossCovererContract,
                tranchesPolicyContract,
                poolContract,
                epochManagerContract,
                seniorTrancheVaultContract,
                juniorTrancheVaultContract,
                creditContract,
            ] = await deployPoolContracts(
                humaConfigContract,
                mockTokenContract,
                "RiskAdjustedTranchesPolicy",
                defaultDeployer,
                poolOwner
            );
        }

        beforeEach(async function () {
            await loadFixture(prepare);
        });

        it("Should not allow non-poolOwner and non-protocolAdmin to enable a pool", async function () {
            await expect(poolContract.enablePool()).to.be.revertedWithCustomError(
                poolConfigContract,
                "permissionDeniedNotAdmin"
            );
        });

        it("Should not enable a pool while no enough first loss cover", async function () {
            await expect(
                poolContract.connect(protocolOwner).enablePool()
            ).to.be.revertedWithCustomError(poolOwnerAndEAlossCovererContract, "notOperator");

            await poolConfigContract.connect(poolOwner).setPoolLiquidityCap(toToken(1_000_000));
            await poolConfigContract
                .connect(poolOwner)
                .setPoolOwnerTreasury(poolOwnerTreasury.address);
            await poolOwnerAndEAlossCovererContract
                .connect(poolOwner)
                .setOperator(poolOwnerTreasury.address, {
                    poolCapCoverageInBps: 1000,
                    poolValueCoverageInBps: 1000,
                });

            await expect(
                poolContract.connect(protocolOwner).enablePool()
            ).to.be.revertedWithCustomError(poolConfigContract, "lessThanRequiredCover");

            await mockTokenContract
                .connect(poolOwnerTreasury)
                .approve(poolOwnerAndEAlossCovererContract.address, ethers.constants.MaxUint256);
            await mockTokenContract.mint(poolOwnerTreasury.address, toToken(10_000_000));
            await poolOwnerAndEAlossCovererContract
                .connect(poolOwnerTreasury)
                .addCover(toToken(200_000));

            await expect(
                poolContract.connect(protocolOwner).enablePool()
            ).to.be.revertedWithCustomError(poolOwnerAndEAlossCovererContract, "notOperator");

            let eaNFTTokenId;
            // Mint EANFT to the ea
            const tx = await eaNFTContract.mintNFT(evaluationAgent.address);
            const receipt = await tx.wait();
            for (const evt of receipt.events) {
                if (evt.event === "NFTGenerated") {
                    eaNFTTokenId = evt.args.tokenId;
                }
            }
            await poolConfigContract
                .connect(poolOwner)
                .setEvaluationAgent(eaNFTTokenId, evaluationAgent.address);
            await poolOwnerAndEAlossCovererContract
                .connect(poolOwner)
                .setOperator(evaluationAgent.address, {
                    poolCapCoverageInBps: 1000,
                    poolValueCoverageInBps: 1000,
                });

            await expect(
                poolContract.connect(protocolOwner).enablePool()
            ).to.be.revertedWithCustomError(poolConfigContract, "lessThanRequiredCover");

            await mockTokenContract
                .connect(evaluationAgent)
                .approve(poolOwnerAndEAlossCovererContract.address, ethers.constants.MaxUint256);
            await mockTokenContract.mint(evaluationAgent.address, toToken(10_000_000));
            await poolOwnerAndEAlossCovererContract
                .connect(evaluationAgent)
                .addCover(toToken(50_000));

            await expect(
                poolContract.connect(protocolOwner).enablePool()
            ).to.be.revertedWithCustomError(poolConfigContract, "lessThanRequiredCover");
        });

        it("Should enable a pool", async function () {
            await poolConfigContract.connect(poolOwner).setPoolLiquidityCap(toToken(1_000_000));
            await poolConfigContract
                .connect(poolOwner)
                .setPoolOwnerTreasury(poolOwnerTreasury.address);
            await poolOwnerAndEAlossCovererContract
                .connect(poolOwner)
                .setOperator(poolOwnerTreasury.address, {
                    poolCapCoverageInBps: 1000,
                    poolValueCoverageInBps: 1000,
                });

            await mockTokenContract
                .connect(poolOwnerTreasury)
                .approve(poolOwnerAndEAlossCovererContract.address, ethers.constants.MaxUint256);
            await mockTokenContract.mint(poolOwnerTreasury.address, toToken(10_000_000));
            await poolOwnerAndEAlossCovererContract
                .connect(poolOwnerTreasury)
                .addCover(toToken(200_000));

            let eaNFTTokenId;
            const tx = await eaNFTContract.mintNFT(evaluationAgent.address);
            const receipt = await tx.wait();
            for (const evt of receipt.events) {
                if (evt.event === "NFTGenerated") {
                    eaNFTTokenId = evt.args.tokenId;
                }
            }
            await poolConfigContract
                .connect(poolOwner)
                .setEvaluationAgent(eaNFTTokenId, evaluationAgent.address);
            await poolOwnerAndEAlossCovererContract
                .connect(poolOwner)
                .setOperator(evaluationAgent.address, {
                    poolCapCoverageInBps: 1000,
                    poolValueCoverageInBps: 1000,
                });

            await mockTokenContract
                .connect(evaluationAgent)
                .approve(poolOwnerAndEAlossCovererContract.address, ethers.constants.MaxUint256);
            await mockTokenContract.mint(evaluationAgent.address, toToken(10_000_000));
            await poolOwnerAndEAlossCovererContract
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
                poolOwner
            );

            [
                poolConfigContract,
                platformFeeManagerContract,
                poolVaultContract,
                calendarContract,
                poolOwnerAndEAlossCovererContract,
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
                [lender]
            );
        }

        beforeEach(async function () {
            await loadFixture(prepare);
        });

        it("Should not allow non-Operator to disable a pool", async function () {
            await expect(poolContract.disablePool()).to.be.revertedWithCustomError(
                poolConfigContract,
                "poolOperatorRequired"
            );
        });

        it("Should disable a pool", async function () {
            await expect(poolContract.connect(poolOperator).disablePool())
                .to.emit(poolContract, "PoolDisabled")
                .withArgs(poolOperator.address);
        });
    });
});
