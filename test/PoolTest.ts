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
    MockPoolCredit,
    MockToken,
    Pool,
    PoolConfig,
    PoolFeeManager,
    PoolSafe,
    RiskAdjustedTranchesPolicy,
    TrancheVault,
} from "../typechain-types";
import {
    CONSTANTS,
    FeeCalculator,
    FirstLossCoverInfo,
    PnLCalculator,
    deployAndSetupPoolContracts,
    deployPoolContracts,
    deployProtocolContracts,
} from "./BaseTest";
import {
    getFirstLossCoverInfo,
    getLatestBlock,
    getMinFirstLossCoverRequirement,
    getMinLiquidityRequirementForEA,
    getMinLiquidityRequirementForPoolOwner,
    overrideFirstLossCoverConfig,
    overrideLPConfig,
    setNextBlockTimestamp,
    sumBNArray,
    toToken,
} from "./TestUtils";

let defaultDeployer: SignerWithAddress,
    protocolOwner: SignerWithAddress,
    treasury: SignerWithAddress,
    eaServiceAccount: SignerWithAddress,
    pdsServiceAccount: SignerWithAddress;
let poolOwner: SignerWithAddress,
    poolOwnerTreasury: SignerWithAddress,
    evaluationAgent: SignerWithAddress,
    poolOperator: SignerWithAddress;
let lender: SignerWithAddress;

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
    creditContract: MockPoolCredit,
    creditDueManagerContract: CreditDueManager;

let feeCalculator: FeeCalculator;

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

    describe("Before the pool is enabled", function () {
        let minPoolOwnerFirstLossCover: BN, minEAFirstLossCover: BN;
        let minPoolOwnerLiquidity: BN, minEALiquidity: BN;

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
            ] = await deployPoolContracts(
                humaConfigContract,
                mockTokenContract,
                "RiskAdjustedTranchesPolicy",
                defaultDeployer,
                poolOwner,
                "MockPoolCredit",
                "BorrowerLevelCreditManager",
            );

            // Set up first loss cover requirements.
            let lpConfig = await poolConfigContract.getLPConfig();
            await poolConfigContract
                .connect(poolOwner)
                .setLPConfig({ ...lpConfig, ...{ liquidityCap: toToken(1_000_000) } });
            await poolConfigContract
                .connect(poolOwner)
                .setPoolOwnerTreasury(poolOwnerTreasury.address);
            await affiliateFirstLossCoverContract
                .connect(poolOwner)
                .setCoverProvider(poolOwnerTreasury.address, {
                    poolCapCoverageInBps: 1000,
                    poolValueCoverageInBps: 1000,
                });

            let eaNFTTokenId;
            const tx = await eaNFTContract.mintNFT(evaluationAgent.address);
            const receipt = await tx.wait();
            for (const evt of receipt.events!) {
                if (evt.event === "NFTGenerated") {
                    eaNFTTokenId = evt.args!.tokenId;
                }
            }
            await poolConfigContract
                .connect(poolOwner)
                .setEvaluationAgent(eaNFTTokenId, evaluationAgent.address);
            await affiliateFirstLossCoverContract
                .connect(poolOwner)
                .setCoverProvider(evaluationAgent.address, {
                    poolCapCoverageInBps: 1000,
                    poolValueCoverageInBps: 1000,
                });

            minPoolOwnerFirstLossCover = await getMinFirstLossCoverRequirement(
                affiliateFirstLossCoverContract,
                poolConfigContract,
                poolContract,
                poolOwnerTreasury.address,
            );
            minEAFirstLossCover = await getMinFirstLossCoverRequirement(
                affiliateFirstLossCoverContract,
                poolConfigContract,
                poolContract,
                evaluationAgent.address,
            );
            minPoolOwnerLiquidity =
                await getMinLiquidityRequirementForPoolOwner(poolConfigContract);
            minEALiquidity = await getMinLiquidityRequirementForEA(poolConfigContract);
        }

        beforeEach(async function () {
            await loadFixture(prepare);
        });

        async function addFirstLossCover(poolOwnerAmount: BN, eaAmount: BN) {
            await mockTokenContract
                .connect(poolOwnerTreasury)
                .approve(affiliateFirstLossCoverContract.address, ethers.constants.MaxUint256);
            await mockTokenContract.mint(poolOwnerTreasury.address, toToken(10_000_000));
            await affiliateFirstLossCoverContract
                .connect(poolOwnerTreasury)
                .depositCover(poolOwnerAmount);

            await mockTokenContract
                .connect(evaluationAgent)
                .approve(affiliateFirstLossCoverContract.address, ethers.constants.MaxUint256);
            await mockTokenContract.mint(evaluationAgent.address, toToken(10_000_000));
            await affiliateFirstLossCoverContract.connect(evaluationAgent).depositCover(eaAmount);
        }

        async function addLiquidity(poolOwnerAmount: BN, eaAmount: BN) {
            await mockTokenContract
                .connect(poolOwnerTreasury)
                .approve(poolSafeContract.address, ethers.constants.MaxUint256);
            await mockTokenContract.mint(poolOwnerTreasury.address, toToken(10_000_000));
            await juniorTrancheVaultContract
                .connect(poolOwnerTreasury)
                .makeInitialDeposit(poolOwnerAmount);

            await mockTokenContract
                .connect(evaluationAgent)
                .approve(poolSafeContract.address, ethers.constants.MaxUint256);
            await mockTokenContract.mint(evaluationAgent.address, toToken(10_000_000));
            await juniorTrancheVaultContract.connect(evaluationAgent).makeInitialDeposit(eaAmount);
        }

        it("Should not allow non-poolOwner and non-protocolAdmin to enable a pool", async function () {
            await expect(poolContract.enablePool()).to.be.revertedWithCustomError(
                poolConfigContract,
                "permissionDeniedNotAdmin",
            );
            const isPoolOn = await poolContract.isPoolOn();
            expect(isPoolOn).to.be.false;
        });

        it("Should not enable a pool when there is not enough first loss cover for the pool owner", async function () {
            await addFirstLossCover(minPoolOwnerFirstLossCover.sub(1), minEAFirstLossCover);

            await expect(
                poolContract.connect(protocolOwner).enablePool(),
            ).to.be.revertedWithCustomError(poolConfigContract, "lessThanRequiredCover");
            const isPoolOn = await poolContract.isPoolOn();
            expect(isPoolOn).to.be.false;
        });

        it("Should not enable a pool when there is not enough first loss cover for the EA", async function () {
            await addFirstLossCover(minPoolOwnerFirstLossCover, minEAFirstLossCover.sub(1));

            await expect(
                poolContract.connect(protocolOwner).enablePool(),
            ).to.be.revertedWithCustomError(poolConfigContract, "lessThanRequiredCover");
            const isPoolOn = await poolContract.isPoolOn();
            expect(isPoolOn).to.be.false;
        });

        it("Should not enable a pool when there is not enough liquidity for the pool owner", async function () {
            await addFirstLossCover(minPoolOwnerFirstLossCover, minEAFirstLossCover);
            await addLiquidity(minPoolOwnerLiquidity.sub(1), minEALiquidity);

            await expect(
                poolContract.connect(protocolOwner).enablePool(),
            ).to.be.revertedWithCustomError(poolConfigContract, "poolOwnerNotEnoughLiquidity");
            const isPoolOn = await poolContract.isPoolOn();
            expect(isPoolOn).to.be.false;
        });

        it("Should not enable a pool when there is not enough liquidity for the EA", async function () {
            await addFirstLossCover(minPoolOwnerFirstLossCover, minEAFirstLossCover);
            await addLiquidity(minPoolOwnerLiquidity, minEALiquidity.sub(1));

            await expect(
                poolContract.connect(protocolOwner).enablePool(),
            ).to.be.revertedWithCustomError(
                poolConfigContract,
                "evaluationAgentNotEnoughLiquidity",
            );
            const isPoolOn = await poolContract.isPoolOn();
            expect(isPoolOn).to.be.false;
        });

        it("Should allow the pool owner to enable a pool when conditions are met", async function () {
            await addFirstLossCover(minPoolOwnerFirstLossCover, minEAFirstLossCover);
            await addLiquidity(minPoolOwnerLiquidity, minEALiquidity);

            await expect(poolContract.connect(protocolOwner).enablePool())
                .to.emit(poolContract, "PoolEnabled")
                .withArgs(protocolOwner.address);
            const isPoolOn = await poolContract.isPoolOn();
            expect(isPoolOn).to.be.true;
        });
    });

    describe("After the pool is enabled", function () {
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
                "MockPoolCredit",
                "BorrowerLevelCreditManager",
                evaluationAgent,
                poolOwnerTreasury,
                poolOperator,
                [lender],
            );

            feeCalculator = new FeeCalculator(humaConfigContract, poolConfigContract);
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

        describe("PnL tests", function () {
            let coverTotalAssets: BN;

            async function prepareForPnL() {
                const juniorDepositAmount = toToken(250_000);
                await juniorTrancheVaultContract
                    .connect(lender)
                    .deposit(juniorDepositAmount, lender.address);
                const seniorDepositAmount = toToken(800_000);
                await seniorTrancheVaultContract
                    .connect(lender)
                    .deposit(seniorDepositAmount, lender.address);
                // Override the config so that first loss covers cover
                // all losses up to the amount of their total assets.
                const firstLossCovers = [
                    borrowerFirstLossCoverContract,
                    affiliateFirstLossCoverContract,
                ];
                coverTotalAssets = sumBNArray(
                    await Promise.all(firstLossCovers.map((cover) => cover.totalAssets())),
                );
                for (const [index, cover] of firstLossCovers.entries()) {
                    await overrideFirstLossCoverConfig(
                        cover,
                        index,
                        poolConfigContract,
                        poolOwner,
                        {
                            coverRateInBps: CONSTANTS.BP_FACTOR,
                            coverCap: coverTotalAssets,
                        },
                    );
                }
            }

            beforeEach(async function () {
                await loadFixture(prepareForPnL);
            });

            describe("distribute PnL", function () {
                async function testDistribution(profit: BN, loss: BN, recovery: BN) {
                    const adjustment = 8000;
                    await overrideLPConfig(poolConfigContract, poolOwner, {
                        tranchesRiskAdjustmentInBps: adjustment,
                    });

                    const block = await getLatestBlock();
                    const nextTS = block.timestamp + 5;
                    await setNextBlockTimestamp(nextTS);

                    const assetInfo = await poolContract.tranchesAssets();
                    let assets = [
                        assetInfo[CONSTANTS.SENIOR_TRANCHE],
                        assetInfo[CONSTANTS.JUNIOR_TRANCHE],
                    ];

                    let firstLossCoverInfos: FirstLossCoverInfo[] = [],
                        newFirstLossCoverInfos: FirstLossCoverInfo[] = [],
                        seniorAssets,
                        juniorAssets,
                        totalAssets,
                        firstLossCoverProfits: BN[] = [],
                        losses: BN[] = [],
                        lossesCoveredByFirstLossCovers: BN[] = [];

                    if (profit.gt(0)) {
                        firstLossCoverInfos = await Promise.all(
                            [borrowerFirstLossCoverContract, affiliateFirstLossCoverContract].map(
                                (contract) => getFirstLossCoverInfo(contract, poolConfigContract),
                            ),
                        );
                        const profitAfterFees =
                            await feeCalculator.calcPoolFeeDistribution(profit);
                        const assetsWithProfits = PnLCalculator.calcProfitForRiskAdjustedPolicy(
                            profitAfterFees,
                            assets,
                            BN.from(adjustment),
                        );
                        let juniorProfitAfterFirstLossCoverProfitDistribution;
                        [
                            juniorProfitAfterFirstLossCoverProfitDistribution,
                            firstLossCoverProfits,
                        ] = await PnLCalculator.calcProfitForFirstLossCovers(
                            assetsWithProfits[CONSTANTS.JUNIOR_TRANCHE].sub(
                                assets[CONSTANTS.JUNIOR_TRANCHE],
                            ),
                            assets[CONSTANTS.JUNIOR_TRANCHE],
                            firstLossCoverInfos,
                        );

                        await expect(
                            creditContract.mockDistributePnL(profit, BN.from(0), BN.from(0)),
                        )
                            .to.emit(poolContract, "ProfitDistributed")
                            .withArgs(
                                profit,
                                assetsWithProfits[CONSTANTS.SENIOR_TRANCHE],
                                assets[CONSTANTS.JUNIOR_TRANCHE].add(
                                    juniorProfitAfterFirstLossCoverProfitDistribution,
                                ),
                            );

                        seniorAssets = await poolContract.trancheTotalAssets(
                            CONSTANTS.SENIOR_TRANCHE,
                        );
                        expect(seniorAssets).to.equal(assetsWithProfits[CONSTANTS.SENIOR_TRANCHE]);
                        juniorAssets = await poolContract.trancheTotalAssets(
                            CONSTANTS.JUNIOR_TRANCHE,
                        );
                        expect(juniorAssets).to.equal(
                            assets[CONSTANTS.JUNIOR_TRANCHE].add(
                                juniorProfitAfterFirstLossCoverProfitDistribution,
                            ),
                        );
                        totalAssets = await poolContract.totalAssets();
                        expect(totalAssets).to.equal(seniorAssets.add(juniorAssets));

                        console.log(`firstLossCoverProfits: ${firstLossCoverProfits}`);

                        newFirstLossCoverInfos = await Promise.all(
                            [borrowerFirstLossCoverContract, affiliateFirstLossCoverContract].map(
                                (contract) => getFirstLossCoverInfo(contract, poolConfigContract),
                            ),
                        );

                        newFirstLossCoverInfos.forEach((info, index) => {
                            expect(info.asset).to.equal(
                                firstLossCoverInfos[index].asset.add(firstLossCoverProfits[index]),
                            );
                        });

                        assets = [seniorAssets, juniorAssets];
                    }

                    if (loss.gt(0)) {
                        firstLossCoverInfos = await Promise.all(
                            [borrowerFirstLossCoverContract, affiliateFirstLossCoverContract].map(
                                (contract) => getFirstLossCoverInfo(contract, poolConfigContract),
                            ),
                        );

                        let assetsWithLosses;
                        [assetsWithLosses, losses, lossesCoveredByFirstLossCovers] =
                            await PnLCalculator.calcLoss(
                                loss,
                                [
                                    assets[CONSTANTS.SENIOR_TRANCHE],
                                    assets[CONSTANTS.JUNIOR_TRANCHE],
                                ],
                                firstLossCoverInfos,
                            );

                        if (
                            losses[CONSTANTS.SENIOR_TRANCHE]
                                .add(losses[CONSTANTS.JUNIOR_TRANCHE])
                                .gt(0)
                        ) {
                            await expect(
                                creditContract.mockDistributePnL(BN.from(0), loss, BN.from(0)),
                            )
                                .to.emit(poolContract, "LossDistributed")
                                .withArgs(
                                    loss.sub(sumBNArray([...lossesCoveredByFirstLossCovers])),
                                    assetsWithLosses[CONSTANTS.SENIOR_TRANCHE],
                                    assetsWithLosses[CONSTANTS.JUNIOR_TRANCHE],
                                    losses[CONSTANTS.SENIOR_TRANCHE],
                                    losses[CONSTANTS.JUNIOR_TRANCHE],
                                );
                        } else {
                            await creditContract.mockDistributePnL(BN.from(0), loss, BN.from(0));
                        }

                        seniorAssets = await poolContract.trancheTotalAssets(
                            CONSTANTS.SENIOR_TRANCHE,
                        );
                        expect(seniorAssets).to.equal(assetsWithLosses[CONSTANTS.SENIOR_TRANCHE]);
                        juniorAssets = await poolContract.trancheTotalAssets(
                            CONSTANTS.JUNIOR_TRANCHE,
                        );
                        expect(juniorAssets).to.equal(assetsWithLosses[CONSTANTS.JUNIOR_TRANCHE]);
                        totalAssets = await poolContract.totalAssets();
                        expect(totalAssets).to.equal(seniorAssets.add(juniorAssets));

                        for (const [index, cover] of [
                            borrowerFirstLossCoverContract,
                            affiliateFirstLossCoverContract,
                        ].entries()) {
                            expect(await cover.coveredLoss()).to.equal(
                                lossesCoveredByFirstLossCovers[index],
                            );
                        }
                        assets = [seniorAssets, juniorAssets];
                    }

                    if (recovery.gt(0)) {
                        firstLossCoverInfos = await Promise.all(
                            [borrowerFirstLossCoverContract, affiliateFirstLossCoverContract].map(
                                (contract) => getFirstLossCoverInfo(contract, poolConfigContract),
                            ),
                        );
                        const [
                            ,
                            assetsWithRecovery,
                            lossesWithRecovery,
                            lossRecoveredByFirstLossCovers,
                        ] = await PnLCalculator.calcLossRecovery(
                            recovery,
                            assets,
                            losses,
                            lossesCoveredByFirstLossCovers,
                        );

                        await expect(
                            creditContract.mockDistributePnL(BN.from(0), BN.from(0), recovery),
                        )
                            .to.emit(poolContract, "LossRecoveryDistributed")
                            .withArgs(
                                losses[CONSTANTS.SENIOR_TRANCHE]
                                    .sub(lossesWithRecovery[CONSTANTS.SENIOR_TRANCHE])
                                    .add(losses[CONSTANTS.JUNIOR_TRANCHE])
                                    .sub(lossesWithRecovery[CONSTANTS.JUNIOR_TRANCHE]),
                                assetsWithRecovery[CONSTANTS.SENIOR_TRANCHE],
                                assetsWithRecovery[CONSTANTS.JUNIOR_TRANCHE],
                                lossesWithRecovery[CONSTANTS.SENIOR_TRANCHE],
                                lossesWithRecovery[CONSTANTS.JUNIOR_TRANCHE],
                            );

                        seniorAssets = await poolContract.trancheTotalAssets(
                            CONSTANTS.SENIOR_TRANCHE,
                        );
                        expect(seniorAssets).to.equal(
                            assetsWithRecovery[CONSTANTS.SENIOR_TRANCHE],
                        );
                        juniorAssets = await poolContract.trancheTotalAssets(
                            CONSTANTS.JUNIOR_TRANCHE,
                        );
                        expect(juniorAssets).to.equal(
                            assetsWithRecovery[CONSTANTS.JUNIOR_TRANCHE],
                        );
                        totalAssets = await poolContract.totalAssets();
                        expect(totalAssets).to.equal(seniorAssets.add(juniorAssets));

                        newFirstLossCoverInfos = await Promise.all(
                            [borrowerFirstLossCoverContract, affiliateFirstLossCoverContract].map(
                                (contract) => getFirstLossCoverInfo(contract, poolConfigContract),
                            ),
                        );

                        newFirstLossCoverInfos.forEach((info, index) => {
                            expect(info.asset).to.equal(
                                firstLossCoverInfos[index].asset.add(
                                    lossRecoveredByFirstLossCovers[index],
                                ),
                            );
                        });
                    }
                }

                it("Should distribute profit correctly", async function () {
                    const profit = toToken(12387);
                    const loss = toToken(0);
                    const recovery = toToken(0);
                    await testDistribution(profit, loss, recovery);
                });

                it("Should distribute loss correctly when first loss covers can cover loss", async function () {
                    const profit = toToken(0),
                        loss = coverTotalAssets,
                        recovery = toToken(0);
                    await testDistribution(profit, loss, recovery);
                });

                it("Should distribute loss correctly when the junior tranche can cover loss", async function () {
                    const assets = await poolContract.currentTranchesAssets();
                    const profit = toToken(0);
                    const loss = coverTotalAssets.add(assets[CONSTANTS.JUNIOR_TRANCHE]);
                    const recovery = toToken(0);

                    await testDistribution(profit, loss, recovery);
                });

                it("Should distribute loss correctly when the senior tranche needs to cover loss", async function () {
                    const assets = await poolContract.currentTranchesAssets();
                    const profit = toToken(0);
                    const loss = coverTotalAssets.add(
                        assets[CONSTANTS.JUNIOR_TRANCHE].add(assets[CONSTANTS.SENIOR_TRANCHE]),
                    );
                    const recovery = toToken(0);

                    await testDistribution(profit, loss, recovery);
                });

                it("Should distribute loss recovery correctly when senior loss can be recovered", async function () {
                    const assets = await poolContract.currentTranchesAssets();
                    const profit = toToken(0);
                    const loss = coverTotalAssets.add(
                        assets[CONSTANTS.SENIOR_TRANCHE].add(assets[CONSTANTS.JUNIOR_TRANCHE]),
                    );
                    const recovery = assets[CONSTANTS.SENIOR_TRANCHE];

                    await testDistribution(profit, loss, recovery);
                });

                it("Should distribute loss recovery correctly when junior loss can be recovered", async function () {
                    const assets = await poolContract.currentTranchesAssets();
                    const profit = toToken(0);
                    const loss = coverTotalAssets.add(
                        assets[CONSTANTS.JUNIOR_TRANCHE].add(assets[CONSTANTS.SENIOR_TRANCHE]),
                    );
                    const recovery = assets[CONSTANTS.JUNIOR_TRANCHE].add(
                        assets[CONSTANTS.SENIOR_TRANCHE],
                    );

                    await testDistribution(profit, loss, recovery);
                });

                it("Should distribute loss recovery correctly when first loss can be recovered", async function () {
                    const assets = await poolContract.currentTranchesAssets();
                    const profit = toToken(0);
                    const loss = coverTotalAssets.add(
                        assets[CONSTANTS.JUNIOR_TRANCHE].add(assets[CONSTANTS.SENIOR_TRANCHE]),
                    );
                    const recovery = coverTotalAssets.add(
                        assets[CONSTANTS.JUNIOR_TRANCHE].add(assets[CONSTANTS.SENIOR_TRANCHE]),
                    );

                    await testDistribution(profit, loss, recovery);
                });

                it("Should distribute profit, loss and loss recovery correctly", async function () {
                    const profit = toToken(12387);
                    const loss = toToken(8493);
                    const recovery = toToken(3485);
                    await testDistribution(profit, loss, recovery);
                });
            });

            describe("trancheTotalAssets and totalAssets", function () {
                async function testAssetCalculation(profit: BN, loss: BN, recovery: BN) {
                    const adjustment = 8000;
                    await overrideLPConfig(poolConfigContract, poolOwner, {
                        tranchesRiskAdjustmentInBps: adjustment,
                    });

                    const block = await getLatestBlock();
                    const nextTS = block.timestamp + 5;
                    await setNextBlockTimestamp(nextTS);

                    const assetInfo = await poolContract.tranchesAssets();
                    const assets = [
                        assetInfo[CONSTANTS.SENIOR_TRANCHE],
                        assetInfo[CONSTANTS.JUNIOR_TRANCHE],
                    ];
                    const profitAfterFees = await feeCalculator.calcPoolFeeDistribution(profit);
                    const assetsWithProfits = PnLCalculator.calcProfitForRiskAdjustedPolicy(
                        profitAfterFees,
                        assets,
                        BN.from(adjustment),
                    );
                    const firstLossCoverInfos = await Promise.all(
                        [borrowerFirstLossCoverContract, affiliateFirstLossCoverContract].map(
                            (contract) => getFirstLossCoverInfo(contract, poolConfigContract),
                        ),
                    );
                    const [juniorProfitAfterFirstLossCoverProfitDistribution] =
                        await PnLCalculator.calcProfitForFirstLossCovers(
                            assetsWithProfits[CONSTANTS.JUNIOR_TRANCHE].sub(
                                assets[CONSTANTS.JUNIOR_TRANCHE],
                            ),
                            assets[CONSTANTS.JUNIOR_TRANCHE],
                            firstLossCoverInfos,
                        );
                    const [assetsWithLosses, losses, lossesCoveredBuFirstLossCovers] =
                        await PnLCalculator.calcLoss(
                            loss,
                            [
                                assetsWithProfits[CONSTANTS.SENIOR_TRANCHE],
                                assets[CONSTANTS.JUNIOR_TRANCHE].add(
                                    juniorProfitAfterFirstLossCoverProfitDistribution,
                                ),
                            ],
                            firstLossCoverInfos,
                        );
                    const [, assetsWithRecovery] = await PnLCalculator.calcLossRecovery(
                        recovery,
                        assetsWithLosses,
                        losses,
                        lossesCoveredBuFirstLossCovers,
                    );

                    await creditContract.mockDistributePnL(profit, loss, recovery);
                    const totalAssets = await poolContract.totalAssets();
                    expect(totalAssets).to.equal(
                        assetsWithRecovery[CONSTANTS.SENIOR_TRANCHE].add(
                            assetsWithRecovery[CONSTANTS.JUNIOR_TRANCHE],
                        ),
                    );
                    const seniorAssets = await poolContract.trancheTotalAssets(
                        CONSTANTS.SENIOR_TRANCHE,
                    );
                    expect(seniorAssets).to.equal(assetsWithRecovery[CONSTANTS.SENIOR_TRANCHE]);
                    const juniorAssets = await poolContract.trancheTotalAssets(
                        CONSTANTS.JUNIOR_TRANCHE,
                    );
                    expect(juniorAssets).to.equal(assetsWithRecovery[CONSTANTS.JUNIOR_TRANCHE]);
                }

                it("Should return the correct asset distribution when there is only profit", async function () {
                    const profit = toToken(12387);
                    const loss = toToken(0);
                    const recovery = toToken(0);
                    await testAssetCalculation(profit, loss, recovery);
                });

                it(
                    "Should return the correct asset distribution when there is profit and loss," +
                        " and first loss cover can cover the loss",
                    async function () {},
                );

                it(
                    "Should return the correct asset distribution when there is profit and loss," +
                        " and the junior tranche needs to cover the loss",
                    async function () {
                        const assets = await poolContract.currentTranchesAssets();
                        const profit = toToken(0);
                        const loss = assets[CONSTANTS.JUNIOR_TRANCHE];
                        const recovery = toToken(0);

                        await testAssetCalculation(profit, loss, recovery);
                    },
                );

                it(
                    "Should return the correct asset distribution when there is profit and loss," +
                        " and the senior tranche needs to cover the loss",
                    async function () {
                        const assets = await poolContract.currentTranchesAssets();
                        const profit = toToken(0);
                        const loss = assets[CONSTANTS.SENIOR_TRANCHE].add(
                            assets[CONSTANTS.JUNIOR_TRANCHE],
                        );
                        const recovery = toToken(0);

                        await testAssetCalculation(profit, loss, recovery);
                    },
                );

                it(
                    "Should return the correct asset distribution when there is profit, loss and recovery," +
                        " and the senior loss can be recovered",
                    async function () {
                        const assets = await poolContract.currentTranchesAssets();
                        const profit = toToken(0);
                        const loss = assets[CONSTANTS.SENIOR_TRANCHE].add(
                            assets[CONSTANTS.JUNIOR_TRANCHE],
                        );
                        const recovery = assets[CONSTANTS.JUNIOR_TRANCHE];

                        await testAssetCalculation(profit, loss, recovery);
                    },
                );

                it(
                    "Should return the correct asset distribution when there is profit, loss and recovery," +
                        " and the junior loss can be recovered",
                    async function () {
                        const assets = await poolContract.currentTranchesAssets();
                        const profit = toToken(0);
                        const loss = assets[CONSTANTS.SENIOR_TRANCHE].add(
                            assets[CONSTANTS.JUNIOR_TRANCHE],
                        );
                        const recovery = assets[CONSTANTS.SENIOR_TRANCHE].add(
                            assets[CONSTANTS.JUNIOR_TRANCHE],
                        );

                        await testAssetCalculation(profit, loss, recovery);
                    },
                );

                it(
                    "Should return the correct asset distribution when there is profit, loss and recovery," +
                        " and the first loss cover loss can be recovered",
                    async function () {},
                );

                it("Should return the correct profit, loss and loss recovery distribution", async function () {
                    const profit = toToken(12387);
                    const loss = toToken(8493);
                    const recovery = toToken(3485);
                    await testAssetCalculation(profit, loss, recovery);
                });
            });

            describe("getFirstLossCoverAvailableCap", function () {
                it(
                    "Should return the difference between the cover capacity and its total assets" +
                        " if the capacity exceeds the assets",
                    async function () {
                        const tranchesAssets = await poolContract.tranchesAssets();
                        const totalTrancheAssets = tranchesAssets.seniorTotalAssets.add(
                            tranchesAssets.juniorTotalAssets,
                        );
                        // Deposit the amount of the cap into the first loss cover contract to make sure there
                        // is no availability.
                        const coverTotalAssets =
                            await affiliateFirstLossCoverContract.totalAssets();
                        const coverCap = coverTotalAssets.add(1);
                        await overrideFirstLossCoverConfig(
                            affiliateFirstLossCoverContract,
                            CONSTANTS.AFFILIATE_FIRST_LOSS_COVER_INDEX,
                            poolConfigContract,
                            poolOwner,
                            {
                                liquidityCap: coverCap,
                                maxPercentOfPoolValueInBps: 0,
                            },
                        );

                        const availableCap = await poolContract.getFirstLossCoverAvailableCap(
                            affiliateFirstLossCoverContract.address,
                            totalTrancheAssets,
                        );
                        expect(availableCap).to.equal(coverCap.sub(coverTotalAssets));
                    },
                );

                it("Should return 0 if there is no room left from the cover's capacity", async function () {
                    const tranchesAssets = await poolContract.tranchesAssets();
                    const totalTrancheAssets = tranchesAssets.seniorTotalAssets.add(
                        tranchesAssets.juniorTotalAssets,
                    );
                    // Deposit the amount of the cap into the first loss cover contract to make sure there
                    // is no availability.
                    await overrideFirstLossCoverConfig(
                        affiliateFirstLossCoverContract,
                        CONSTANTS.AFFILIATE_FIRST_LOSS_COVER_INDEX,
                        poolConfigContract,
                        poolOwner,
                        {
                            liquidityCap: toToken(1_000_000),
                        },
                    );
                    const coverCap =
                        await affiliateFirstLossCoverContract.getCapacity(totalTrancheAssets);
                    await affiliateFirstLossCoverContract
                        .connect(evaluationAgent)
                        .depositCover(coverCap);

                    const availableCap = await poolContract.getFirstLossCoverAvailableCap(
                        affiliateFirstLossCoverContract.address,
                        totalTrancheAssets,
                    );
                    expect(availableCap).to.equal(ethers.constants.Zero);
                });
            });
        });

        describe("View functions", function () {
            it("Should return correct tranche available caps", async function () {
                const seniorAvailableCap = await poolContract.getTrancheAvailableCap(
                    CONSTANTS.SENIOR_TRANCHE,
                );
                const juniorAvailableCap = await await poolContract.getTrancheAvailableCap(
                    CONSTANTS.JUNIOR_TRANCHE,
                );
                console.log(
                    `seniorAvailableCap: ${seniorAvailableCap}, juniorAvailableCap: ${juniorAvailableCap}`,
                );
                const lpConfig = await poolConfigContract.getLPConfig();
                const tranchesAssets = await poolContract.currentTranchesAssets();
                expect(seniorAvailableCap).to.greaterThan(0);
                expect(juniorAvailableCap).to.greaterThan(0);
                expect(juniorAvailableCap).to.equal(
                    lpConfig.liquidityCap.sub(tranchesAssets[CONSTANTS.JUNIOR_TRANCHE]),
                );
                expect(seniorAvailableCap).to.equal(
                    tranchesAssets[CONSTANTS.JUNIOR_TRANCHE]
                        .mul(lpConfig.maxSeniorJuniorRatio)
                        .sub(tranchesAssets[CONSTANTS.SENIOR_TRANCHE]),
                );
            });
        });
    });
});
