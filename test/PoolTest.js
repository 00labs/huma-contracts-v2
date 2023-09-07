const {ethers} = require("hardhat");
const {expect} = require("chai");
const {BigNumber: BN} = require("ethers");
const {loadFixture} = require("@nomicfoundation/hardhat-network-helpers");
const {
    deployProtocolContracts,
    deployPoolContracts,
    deployAndSetupPoolContracts,
    CONSTANTS,
    PnLCalculator,
} = require("./BaseTest");
const {toToken, mineNextBlockWithTimestamp, setNextBlockTimestamp} = require("./TestUtils");

let defaultDeployer, protocolOwner, treasury, eaServiceAccount, pdsServiceAccount;
let poolOwner, poolOwnerTreasury, evaluationAgent, poolOperator;
let lender;

let eaNFTContract, humaConfigContract, mockTokenContract;
let poolConfigContract,
    platformFeeManagerContract,
    poolVaultContract,
    calendarContract,
    poolOwnerAndEAFirstLossCoverContract,
    tranchesPolicyContract,
    poolContract,
    epochManagerContract,
    seniorTrancheVaultContract,
    juniorTrancheVaultContract,
    creditContract,
    creditFeeManagerContract,
    creditPnlManagerContract;

describe("Pool Test", function () {
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
                poolOwnerAndEAFirstLossCoverContract,
                tranchesPolicyContract,
                poolContract,
                epochManagerContract,
                seniorTrancheVaultContract,
                juniorTrancheVaultContract,
                creditContract,
                creditFeeManagerContract,
                creditPnlManagerContract,
            ] = await deployPoolContracts(
                humaConfigContract,
                mockTokenContract,
                "RiskAdjustedTranchesPolicy",
                defaultDeployer,
                poolOwner,
                "MockPoolCredit"
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
                poolContract.connect(protocolOwner).enablePool()
            ).to.be.revertedWithCustomError(poolConfigContract, "lessThanRequiredCover");

            await mockTokenContract
                .connect(poolOwnerTreasury)
                .approve(
                    poolOwnerAndEAFirstLossCoverContract.address,
                    ethers.constants.MaxUint256
                );
            await mockTokenContract.mint(poolOwnerTreasury.address, toToken(10_000_000));
            await poolOwnerAndEAFirstLossCoverContract
                .connect(poolOwnerTreasury)
                .addCover(toToken(200_000));

            await expect(
                poolContract.connect(protocolOwner).enablePool()
            ).to.be.revertedWithCustomError(poolOwnerAndEAFirstLossCoverContract, "notOperator");

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
            await poolOwnerAndEAFirstLossCoverContract
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
                .approve(
                    poolOwnerAndEAFirstLossCoverContract.address,
                    ethers.constants.MaxUint256
                );
            await mockTokenContract.mint(evaluationAgent.address, toToken(10_000_000));
            await poolOwnerAndEAFirstLossCoverContract
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
            await poolOwnerAndEAFirstLossCoverContract
                .connect(poolOwner)
                .setOperator(poolOwnerTreasury.address, {
                    poolCapCoverageInBps: 1000,
                    poolValueCoverageInBps: 1000,
                });

            await mockTokenContract
                .connect(poolOwnerTreasury)
                .approve(
                    poolOwnerAndEAFirstLossCoverContract.address,
                    ethers.constants.MaxUint256
                );
            await mockTokenContract.mint(poolOwnerTreasury.address, toToken(10_000_000));
            await poolOwnerAndEAFirstLossCoverContract
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
            await poolOwnerAndEAFirstLossCoverContract
                .connect(poolOwner)
                .setOperator(evaluationAgent.address, {
                    poolCapCoverageInBps: 1000,
                    poolValueCoverageInBps: 1000,
                });

            await mockTokenContract
                .connect(evaluationAgent)
                .approve(
                    poolOwnerAndEAFirstLossCoverContract.address,
                    ethers.constants.MaxUint256
                );
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
                poolOwner
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
                creditContract,
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

        describe("PnL Tests", function () {
            async function prepareForPnL() {
                let juniorDepositAmount = toToken(250_000);
                await juniorTrancheVaultContract
                    .connect(lender)
                    .deposit(juniorDepositAmount, lender.address);
                let seniorDepositAmount = toToken(800_000);
                await seniorTrancheVaultContract
                    .connect(lender)
                    .deposit(seniorDepositAmount, lender.address);
            }

            beforeEach(async function () {
                await loadFixture(prepareForPnL);
            });

            it("Should distribute profit correctly", async function () {});

            it("Should distribute loss correctly while first loss can cover loss", async function () {});

            it("Should distribute loss correctly while junior assets can cover loss", async function () {});

            it("Should distribute loss correctly while junior assets can not cover loss", async function () {});

            it("Should distribute loss recovery correctly while senior loss can be recovered", async function () {});

            it("Should distribute loss recovery correctly while junior loss can be recovered", async function () {});

            it("Should distribute loss recovery correctly while first loss can be recovered", async function () {});

            it("Should distribute profit, loss and loss recovery correctly", async function () {
                let profit = toToken(12387);
                let loss = toToken(8493);
                let recovery = toToken(3485);

                await creditContract.setRefreshPnLReturns(profit, loss, recovery);
                await poolConfigContract
                    .connect(poolOwner)
                    .setEpochManager(defaultDeployer.address);
                const adjustment = BN.from(8000);
                let lpConfig = await poolConfigContract.getLPConfig();
                let newLpConfig = {...lpConfig, tranchesRiskAdjustmentInBps: adjustment};
                await poolConfigContract.connect(poolOwner).setLPConfig(newLpConfig);

                let block = await ethers.provider.getBlock();
                let nextTS = block.timestamp + 5;
                await setNextBlockTimestamp(nextTS);

                let assets = await poolContract.currentTranchesAssets();
                let profitAfterFees = await platformFeeManagerContract.calcPlatformFeeDistribution(
                    profit
                );
                assets = PnLCalculator.calcProfitForRiskAdjustedPolicy(
                    profitAfterFees,
                    assets,
                    adjustment
                );
                let losses;
                [assets, losses] = PnLCalculator.calcLoss(loss, assets);
                [, assets, losses] = PnLCalculator.calcLossRecovery(recovery, assets, losses);

                await expect(await poolContract.refreshPool())
                    .to.emit(poolContract, "PoolAssetsRefreshed")
                    .withArgs(
                        nextTS,
                        profit,
                        loss,
                        recovery,
                        // 0,
                        assets[CONSTANTS.SENIOR_TRANCHE_INDEX],
                        assets[CONSTANTS.JUNIOR_TRANCHE_INDEX],
                        losses[CONSTANTS.SENIOR_TRANCHE_INDEX],
                        losses[CONSTANTS.JUNIOR_TRANCHE_INDEX]
                    );
            });
        });
    });
});
