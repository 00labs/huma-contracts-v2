import { ethers } from "hardhat";

import { expect } from "chai";
import { deployAndSetupPoolContracts, deployProtocolContracts } from "./BaseTest";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import {
    BaseCreditFeeManager,
    BasePnLManager,
    Calendar,
    EpochManager,
    EvaluationAgentNFT,
    HumaConfig,
    FirstLossCover,
    MockPoolCredit,
    MockToken,
    PlatformFeeManager,
    Pool,
    PoolConfig,
    PoolVault,
    RiskAdjustedTranchesPolicy,
    TrancheVault,
} from "../typechain-types";
import { copyLPConfigWithOverrides, toToken } from "./TestUtils";
import { BigNumber as BN } from "ethers";

let defaultDeployer: SignerWithAddress,
    protocolOwner: SignerWithAddress,
    eaServiceAccount: SignerWithAddress,
    pdsServiceAccount: SignerWithAddress;
let poolOwner: SignerWithAddress,
    poolOwnerTreasury: SignerWithAddress,
    evaluationAgent: SignerWithAddress,
    evaluationAgent2: SignerWithAddress,
    poolOperator: SignerWithAddress,
    protocolTreasury: SignerWithAddress,
    regularUser: SignerWithAddress;

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
    creditContract: MockPoolCredit,
    creditFeeManagerContract: BaseCreditFeeManager,
    creditPnlManagerContract: BasePnLManager;

describe("PoolConfig Test", function () {
    before(async function () {
        [
            defaultDeployer,
            protocolOwner,
            protocolTreasury,
            eaServiceAccount,
            pdsServiceAccount,
            poolOwner,
            poolOwnerTreasury,
            evaluationAgent,
            evaluationAgent2,
            poolOperator,
            regularUser,
        ] = await ethers.getSigners();
    });

    async function deployPoolConfigContract() {
        [, humaConfigContract, mockTokenContract] = await deployProtocolContracts(
            protocolOwner,
            protocolTreasury,
            eaServiceAccount,
            pdsServiceAccount,
            poolOwner,
        );
        const PoolConfig = await ethers.getContractFactory("PoolConfig");
        poolConfigContract = await PoolConfig.deploy();
        await poolConfigContract.deployed();
        await poolConfigContract.grantRole(
            await poolConfigContract.DEFAULT_ADMIN_ROLE(),
            poolOwner.address,
        );

        const PlatformFeeManager = await ethers.getContractFactory("PlatformFeeManager");
        platformFeeManagerContract = await PlatformFeeManager.deploy();
        await platformFeeManagerContract.deployed();

        const PoolVault = await ethers.getContractFactory("PoolVault");
        poolVaultContract = await PoolVault.deploy();
        await poolVaultContract.deployed();

        const FirstLossCover = await ethers.getContractFactory("FirstLossCover");
        poolOwnerAndEAFirstLossCoverContract = await FirstLossCover.deploy();
        await poolOwnerAndEAFirstLossCoverContract.deployed();

        const TranchesPolicy = await ethers.getContractFactory("RiskAdjustedTranchesPolicy");
        tranchesPolicyContract = await TranchesPolicy.deploy();
        await tranchesPolicyContract.deployed();

        const Pool = await ethers.getContractFactory("Pool");
        poolContract = await Pool.deploy();
        await poolContract.deployed();

        const EpochManager = await ethers.getContractFactory("EpochManager");
        epochManagerContract = await EpochManager.deploy();
        await epochManagerContract.deployed();

        const TrancheVault = await ethers.getContractFactory("TrancheVault");
        seniorTrancheVaultContract = await TrancheVault.deploy();
        await seniorTrancheVaultContract.deployed();
        juniorTrancheVaultContract = await TrancheVault.deploy();
        await juniorTrancheVaultContract.deployed();

        const Calendar = await ethers.getContractFactory("Calendar");
        calendarContract = await Calendar.deploy();
        await calendarContract.deployed();

        const Credit = await ethers.getContractFactory("MockPoolCredit");
        creditContract = await Credit.deploy();
        await creditContract.deployed();

        const BaseCreditFeeManager = await ethers.getContractFactory("BaseCreditFeeManager");
        creditFeeManagerContract = await BaseCreditFeeManager.deploy();
        await creditFeeManagerContract.deployed();

        const CreditPnLManager = await ethers.getContractFactory("LinearMarkdownPnLManager");
        creditPnlManagerContract = await CreditPnLManager.deploy();
        await creditPnlManagerContract.deployed();
    }

    beforeEach(async function () {
        await loadFixture(deployPoolConfigContract);
    });

    describe("Pool config initialization", function () {
        it("Should initialize successfully and sets default values", async function () {
            await poolConfigContract
                .connect(poolOwner)
                .initialize("Base Credit Pool", [
                    humaConfigContract.address,
                    mockTokenContract.address,
                    platformFeeManagerContract.address,
                    poolVaultContract.address,
                    calendarContract.address,
                    poolOwnerAndEAFirstLossCoverContract.address,
                    tranchesPolicyContract.address,
                    poolContract.address,
                    epochManagerContract.address,
                    seniorTrancheVaultContract.address,
                    juniorTrancheVaultContract.address,
                    creditContract.address,
                    creditFeeManagerContract.address,
                    creditPnlManagerContract.address,
                ]);

            const poolSettings = await poolConfigContract.getPoolSettings();
            expect(poolSettings.calendarUnit).to.equal(1);
            expect(poolSettings.payPeriodInCalendarUnit).to.equal(1);
            expect(poolSettings.advanceRateInBps).to.equal(10000);
            expect(poolSettings.latePaymentGracePeriodInDays).to.equal(5);
            expect(poolSettings.defaultGracePeriodInCalendarUnit).to.equal(3);

            const adminRnR = await poolConfigContract.getAdminRnR();
            expect(adminRnR.rewardRateInBpsForEA).to.equal(300);
            expect(adminRnR.rewardRateInBpsForPoolOwner).to.equal(200);
            expect(adminRnR.liquidityRateInBpsByEA).to.equal(200);
            expect(adminRnR.liquidityRateInBpsByPoolOwner).to.equal(200);

            const lpConfig = await poolConfigContract.getLPConfig();
            expect(lpConfig.maxSeniorJuniorRatio).to.equal(4);
        });
        it("Should reject non-owner's call to initialize()", async function () {
            await expect(
                poolConfigContract
                    .connect(regularUser)
                    .initialize("Base Credit Pool", [
                        humaConfigContract.address,
                        mockTokenContract.address,
                        platformFeeManagerContract.address,
                        poolVaultContract.address,
                        calendarContract.address,
                        poolOwnerAndEAFirstLossCoverContract.address,
                        tranchesPolicyContract.address,
                        poolContract.address,
                        epochManagerContract.address,
                        seniorTrancheVaultContract.address,
                        juniorTrancheVaultContract.address,
                        creditContract.address,
                        creditFeeManagerContract.address,
                        creditPnlManagerContract.address,
                    ]),
            ).to.be.revertedWithCustomError(poolConfigContract, "notPoolOwner");
        });
        it("Should reject zero address for HumaConfig", async function () {
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize("Base Credit Pool", [
                        ethers.constants.AddressZero,
                        mockTokenContract.address,
                        platformFeeManagerContract.address,
                        poolVaultContract.address,
                        calendarContract.address,
                        poolOwnerAndEAFirstLossCoverContract.address,
                        tranchesPolicyContract.address,
                        poolContract.address,
                        epochManagerContract.address,
                        seniorTrancheVaultContract.address,
                        juniorTrancheVaultContract.address,
                        creditContract.address,
                        creditFeeManagerContract.address,
                        creditPnlManagerContract.address,
                    ]),
            ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
        });
        it("Should reject invalid underlying tokens", async function () {
            await humaConfigContract
                .connect(protocolOwner)
                .setLiquidityAsset(mockTokenContract.address, false);
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize("Base Credit Pool", [
                        humaConfigContract.address,
                        ethers.constants.AddressZero,
                        platformFeeManagerContract.address,
                        poolVaultContract.address,
                        calendarContract.address,
                        poolOwnerAndEAFirstLossCoverContract.address,
                        tranchesPolicyContract.address,
                        poolContract.address,
                        epochManagerContract.address,
                        seniorTrancheVaultContract.address,
                        juniorTrancheVaultContract.address,
                        creditContract.address,
                        creditFeeManagerContract.address,
                        creditPnlManagerContract.address,
                    ]),
            ).to.be.revertedWithCustomError(
                poolConfigContract,
                "underlyingTokenNotApprovedForHumaProtocol",
            );
        });
        it("Should reject zero address for platformFeeManager", async function () {
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize("Base Credit Pool", [
                        humaConfigContract.address,
                        mockTokenContract.address,
                        ethers.constants.AddressZero,
                        poolVaultContract.address,
                        calendarContract.address,
                        poolOwnerAndEAFirstLossCoverContract.address,
                        tranchesPolicyContract.address,
                        poolContract.address,
                        epochManagerContract.address,
                        seniorTrancheVaultContract.address,
                        juniorTrancheVaultContract.address,
                        creditContract.address,
                        creditFeeManagerContract.address,
                        creditPnlManagerContract.address,
                    ]),
            ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
        });
        it("Should reject zero address for poolVault", async function () {
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize("Base Credit Pool", [
                        humaConfigContract.address,
                        mockTokenContract.address,
                        platformFeeManagerContract.address,
                        ethers.constants.AddressZero,
                        calendarContract.address,
                        poolOwnerAndEAFirstLossCoverContract.address,
                        tranchesPolicyContract.address,
                        poolContract.address,
                        epochManagerContract.address,
                        seniorTrancheVaultContract.address,
                        juniorTrancheVaultContract.address,
                        creditContract.address,
                        creditFeeManagerContract.address,
                        creditPnlManagerContract.address,
                    ]),
            ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
        });
        it("Should reject zero address for calendar", async function () {
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize("Base Credit Pool", [
                        humaConfigContract.address,
                        mockTokenContract.address,
                        platformFeeManagerContract.address,
                        poolVaultContract.address,
                        ethers.constants.AddressZero,
                        poolOwnerAndEAFirstLossCoverContract.address,
                        tranchesPolicyContract.address,
                        poolContract.address,
                        epochManagerContract.address,
                        seniorTrancheVaultContract.address,
                        juniorTrancheVaultContract.address,
                        creditContract.address,
                        creditFeeManagerContract.address,
                        creditPnlManagerContract.address,
                    ]),
            ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
        });
        it("Should reject zero address for poolOwnerOrEAFirstLossCover", async function () {
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize("Base Credit Pool", [
                        humaConfigContract.address,
                        mockTokenContract.address,
                        platformFeeManagerContract.address,
                        poolVaultContract.address,
                        calendarContract.address,
                        ethers.constants.AddressZero,
                        tranchesPolicyContract.address,
                        poolContract.address,
                        epochManagerContract.address,
                        seniorTrancheVaultContract.address,
                        juniorTrancheVaultContract.address,
                        creditContract.address,
                        creditFeeManagerContract.address,
                        creditPnlManagerContract.address,
                    ]),
            ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
        });
        it("Should reject zero address for tranchePolicy", async function () {
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize("Base Credit Pool", [
                        humaConfigContract.address,
                        mockTokenContract.address,
                        platformFeeManagerContract.address,
                        poolVaultContract.address,
                        calendarContract.address,
                        poolOwnerAndEAFirstLossCoverContract.address,
                        ethers.constants.AddressZero,
                        poolContract.address,
                        epochManagerContract.address,
                        seniorTrancheVaultContract.address,
                        juniorTrancheVaultContract.address,
                        creditContract.address,
                        creditFeeManagerContract.address,
                        creditPnlManagerContract.address,
                    ]),
            ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
        });
        it("Should reject zero address for the pool", async function () {
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize("Base Credit Pool", [
                        humaConfigContract.address,
                        mockTokenContract.address,
                        platformFeeManagerContract.address,
                        poolVaultContract.address,
                        calendarContract.address,
                        poolOwnerAndEAFirstLossCoverContract.address,
                        tranchesPolicyContract.address,
                        ethers.constants.AddressZero,
                        epochManagerContract.address,
                        seniorTrancheVaultContract.address,
                        juniorTrancheVaultContract.address,
                        creditContract.address,
                        creditFeeManagerContract.address,
                        creditPnlManagerContract.address,
                    ]),
            ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
        });
        it("Should reject zero address for epochManager", async function () {
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize("Base Credit Pool", [
                        humaConfigContract.address,
                        mockTokenContract.address,
                        platformFeeManagerContract.address,
                        poolVaultContract.address,
                        calendarContract.address,
                        poolOwnerAndEAFirstLossCoverContract.address,
                        tranchesPolicyContract.address,
                        poolContract.address,
                        ethers.constants.AddressZero,
                        seniorTrancheVaultContract.address,
                        juniorTrancheVaultContract.address,
                        creditContract.address,
                        creditFeeManagerContract.address,
                        creditPnlManagerContract.address,
                    ]),
            ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
        });
        it("Should reject zero address for seniorTranche", async function () {
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize("Base Credit Pool", [
                        humaConfigContract.address,
                        mockTokenContract.address,
                        platformFeeManagerContract.address,
                        poolVaultContract.address,
                        calendarContract.address,
                        poolOwnerAndEAFirstLossCoverContract.address,
                        tranchesPolicyContract.address,
                        poolContract.address,
                        epochManagerContract.address,
                        ethers.constants.AddressZero,
                        juniorTrancheVaultContract.address,
                        creditContract.address,
                        creditFeeManagerContract.address,
                        creditPnlManagerContract.address,
                    ]),
            ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
        });
        it("Should reject zero address for juniorTranche", async function () {
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize("Base Credit Pool", [
                        humaConfigContract.address,
                        mockTokenContract.address,
                        platformFeeManagerContract.address,
                        poolVaultContract.address,
                        calendarContract.address,
                        poolOwnerAndEAFirstLossCoverContract.address,
                        tranchesPolicyContract.address,
                        poolContract.address,
                        epochManagerContract.address,
                        seniorTrancheVaultContract.address,
                        ethers.constants.AddressZero,
                        creditContract.address,
                        creditFeeManagerContract.address,
                        creditPnlManagerContract.address,
                    ]),
            ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
        });
        it("Should reject zero address for credit", async function () {
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize("Base Credit Pool", [
                        humaConfigContract.address,
                        mockTokenContract.address,
                        platformFeeManagerContract.address,
                        poolVaultContract.address,
                        calendarContract.address,
                        poolOwnerAndEAFirstLossCoverContract.address,
                        tranchesPolicyContract.address,
                        poolContract.address,
                        epochManagerContract.address,
                        seniorTrancheVaultContract.address,
                        juniorTrancheVaultContract.address,
                        ethers.constants.AddressZero,
                        creditFeeManagerContract.address,
                        creditPnlManagerContract.address,
                    ]),
            ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
        });
        it("Should reject zero address for creditFeeManager", async function () {
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize("Base Credit Pool", [
                        humaConfigContract.address,
                        mockTokenContract.address,
                        platformFeeManagerContract.address,
                        poolVaultContract.address,
                        calendarContract.address,
                        poolOwnerAndEAFirstLossCoverContract.address,
                        tranchesPolicyContract.address,
                        poolContract.address,
                        epochManagerContract.address,
                        seniorTrancheVaultContract.address,
                        juniorTrancheVaultContract.address,
                        creditContract.address,
                        ethers.constants.AddressZero,
                        creditPnlManagerContract.address,
                    ]),
            ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
        });
        it("Should reject zero address for creditPnLManager", async function () {
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize("Base Credit Pool", [
                        humaConfigContract.address,
                        mockTokenContract.address,
                        platformFeeManagerContract.address,
                        poolVaultContract.address,
                        calendarContract.address,
                        poolOwnerAndEAFirstLossCoverContract.address,
                        tranchesPolicyContract.address,
                        poolContract.address,
                        epochManagerContract.address,
                        seniorTrancheVaultContract.address,
                        juniorTrancheVaultContract.address,
                        creditContract.address,
                        creditFeeManagerContract.address,
                        ethers.constants.AddressZero,
                    ]),
            ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
        });
        it("Should reject repeated call to initialize()", async function () {
            await poolConfigContract
                .connect(poolOwner)
                .initialize("Base Credit Pool", [
                    humaConfigContract.address,
                    mockTokenContract.address,
                    platformFeeManagerContract.address,
                    poolVaultContract.address,
                    calendarContract.address,
                    poolOwnerAndEAFirstLossCoverContract.address,
                    tranchesPolicyContract.address,
                    poolContract.address,
                    epochManagerContract.address,
                    seniorTrancheVaultContract.address,
                    juniorTrancheVaultContract.address,
                    creditContract.address,
                    creditFeeManagerContract.address,
                    creditPnlManagerContract.address,
                ]);
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize("Base Credit Pool", [
                        humaConfigContract.address,
                        mockTokenContract.address,
                        platformFeeManagerContract.address,
                        poolVaultContract.address,
                        calendarContract.address,
                        poolOwnerAndEAFirstLossCoverContract.address,
                        tranchesPolicyContract.address,
                        poolContract.address,
                        epochManagerContract.address,
                        seniorTrancheVaultContract.address,
                        juniorTrancheVaultContract.address,
                        creditContract.address,
                        creditFeeManagerContract.address,
                        creditPnlManagerContract.address,
                    ]),
            ).to.revertedWith("Initializable: contract is already initialized");
        });
    });

    describe("Pool config admin functions", function () {
        async function deployAndSetupContracts() {
            [eaNFTContract, humaConfigContract, mockTokenContract] = await deployProtocolContracts(
                protocolOwner,
                protocolTreasury,
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
                "FixedAprTranchesPolicy",
                defaultDeployer,
                poolOwner,
                "MockPoolCredit",
                evaluationAgent,
                poolOwnerTreasury,
                poolOperator,
                [regularUser],
            );
        }

        beforeEach(async function () {
            await loadFixture(deployAndSetupContracts);
        });

        describe("setYield", function () {
            const yieldInBps = 1000;

            it("Should allow the pool owner set the yield for the pool", async function () {
                await poolConfigContract.connect(poolOwner).setYield(yieldInBps);
                const poolSummary = await poolConfigContract.getPoolSummary();
                expect(poolSummary[1]).to.equal(yieldInBps);
            });

            it("Should allow the Huma master admin set the yield for the pool", async function () {
                await poolConfigContract.connect(protocolOwner).setYield(yieldInBps);
                const poolSummary = await poolConfigContract.getPoolSummary();
                expect(poolSummary[1]).to.equal(yieldInBps);
            });

            it("Should reject non-owner or Huma master admin", async function () {
                await expect(
                    poolConfigContract.connect(regularUser).setYield(yieldInBps),
                ).to.be.revertedWithCustomError(poolConfigContract, "permissionDeniedNotAdmin");
            });
        });

        describe("setCreditApprovalExpiration", function () {
            const durationInDays = 5;

            it("Should allow the pool owner set the yield for the pool", async function () {
                await poolConfigContract
                    .connect(poolOwner)
                    .setCreditApprovalExpiration(durationInDays);
                const poolSettings = await poolConfigContract.getPoolSettings();
                expect(poolSettings[3]).to.equal(durationInDays);
            });

            it("Should allow the Huma master admin set the yield for the pool", async function () {
                await poolConfigContract
                    .connect(protocolOwner)
                    .setCreditApprovalExpiration(durationInDays);
                const poolSettings = await poolConfigContract.getPoolSettings();
                expect(poolSettings[3]).to.equal(durationInDays);
            });

            it("Should reject non-owner or Huma master admin", async function () {
                await expect(
                    poolConfigContract
                        .connect(regularUser)
                        .setCreditApprovalExpiration(durationInDays),
                ).to.be.revertedWithCustomError(poolConfigContract, "permissionDeniedNotAdmin");
            });
        });

        describe("setPoolOwnerRewardsAndLiquidity", function () {
            const rewardsRate = 100;
            const liquidityRate = 200;

            it("Should allow setting rewards and liquidity by the pool owner", async function () {
                const tx = await poolConfigContract
                    .connect(poolOwner)
                    .setPoolOwnerRewardsAndLiquidity(rewardsRate, liquidityRate);
                const adminRnR = await poolConfigContract.getAdminRnR();
                expect(adminRnR.rewardRateInBpsForPoolOwner).to.equal(rewardsRate);
                expect(adminRnR.liquidityRateInBpsByPoolOwner).to.equal(liquidityRate);
                await expect(tx)
                    .to.emit(poolConfigContract, "PoolOwnerRewardsAndLiquidityChanged")
                    .withArgs(rewardsRate, liquidityRate, poolOwner.address);
            });

            it("Should allow setting rewards and liquidity by the Huma master admin", async function () {
                const tx = await poolConfigContract
                    .connect(protocolOwner)
                    .setPoolOwnerRewardsAndLiquidity(rewardsRate, liquidityRate);
                const adminRnR = await poolConfigContract.getAdminRnR();
                expect(adminRnR.rewardRateInBpsForPoolOwner).to.equal(rewardsRate);
                expect(adminRnR.liquidityRateInBpsByPoolOwner).to.equal(liquidityRate);
                await expect(tx)
                    .to.emit(poolConfigContract, "PoolOwnerRewardsAndLiquidityChanged")
                    .withArgs(rewardsRate, liquidityRate, protocolOwner.address);
            });

            it("Should not allow other users to set the rates", async function () {
                await expect(
                    poolConfigContract
                        .connect(regularUser)
                        .setPoolOwnerRewardsAndLiquidity(rewardsRate, liquidityRate),
                ).to.be.revertedWithCustomError(poolConfigContract, "permissionDeniedNotAdmin");
            });

            it("Should fail if rewards rate exceeds 100%", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setPoolOwnerRewardsAndLiquidity(15000, liquidityRate),
                ).to.be.revertedWithCustomError(
                    poolConfigContract,
                    "invalidBasisPointHigherThan10000",
                );
            });

            it("Should fail if liquidity rate exceeds 100%", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setPoolOwnerRewardsAndLiquidity(rewardsRate, 15000),
                ).to.be.revertedWithCustomError(
                    poolConfigContract,
                    "invalidBasisPointHigherThan10000",
                );
            });
        });

        describe("setEARewardsAndLiquidity", function () {
            const rewardsRate = 100;
            const liquidityRate = 200;

            it("Should allow setting rewards and liquidity by the pool owner", async function () {
                const tx = await poolConfigContract
                    .connect(poolOwner)
                    .setEARewardsAndLiquidity(rewardsRate, liquidityRate);
                const adminRnR = await poolConfigContract.getAdminRnR();
                expect(adminRnR.rewardRateInBpsForEA).to.equal(rewardsRate);
                expect(adminRnR.liquidityRateInBpsByEA).to.equal(liquidityRate);
                await expect(tx)
                    .to.emit(poolConfigContract, "EARewardsAndLiquidityChanged")
                    .withArgs(rewardsRate, liquidityRate, poolOwner.address);
            });

            it("Should allow setting rewards and liquidity by the Huma master admin", async function () {
                const tx = await poolConfigContract
                    .connect(protocolOwner)
                    .setEARewardsAndLiquidity(rewardsRate, liquidityRate);
                const adminRnR = await poolConfigContract.getAdminRnR();
                expect(adminRnR.rewardRateInBpsForEA).to.equal(rewardsRate);
                expect(adminRnR.liquidityRateInBpsByEA).to.equal(liquidityRate);
                await expect(tx)
                    .to.emit(poolConfigContract, "EARewardsAndLiquidityChanged")
                    .withArgs(rewardsRate, liquidityRate, protocolOwner.address);
            });

            it("Should not allow other users to set the rates", async function () {
                await expect(
                    poolConfigContract
                        .connect(regularUser)
                        .setEARewardsAndLiquidity(rewardsRate, liquidityRate),
                ).to.be.revertedWithCustomError(poolConfigContract, "permissionDeniedNotAdmin");
                const adminRnR = await poolConfigContract.getAdminRnR();
            });

            it("Should fail if rewards rate exceeds 100%", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setEARewardsAndLiquidity(15000, liquidityRate),
                ).to.be.revertedWithCustomError(
                    poolConfigContract,
                    "invalidBasisPointHigherThan10000",
                );
            });

            it("Should fail if liquidity rate exceeds 100%", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setEARewardsAndLiquidity(rewardsRate, 15000),
                ).to.be.revertedWithCustomError(
                    poolConfigContract,
                    "invalidBasisPointHigherThan10000",
                );
            });
        });

        describe("setEvaluationAgent", function () {
            let liquidityCap: BN;
            let newNFTTokenId: string;
            let firstLossCoverAmount: BN;

            beforeEach(async function () {
                liquidityCap = toToken(2_000_000);
                const tx = await eaNFTContract.mintNFT(evaluationAgent2.address);
                const receipt = await tx.wait();
                for (const evt of receipt.events!) {
                    if (evt.event === "NFTGenerated") {
                        newNFTTokenId = evt.args!.tokenId;
                    }
                }

                // Set the EA to be an operator.
                await poolOwnerAndEAFirstLossCoverContract
                    .connect(poolOwner)
                    .setOperator(evaluationAgent2.getAddress(), {
                        poolCapCoverageInBps: 100,
                        poolValueCoverageInBps: 100,
                    });

                // Set a new LP config so that we can configure a non-trivial first loss cover threshold.
                const lpConfig = await poolConfigContract.getLPConfig();
                const newLpConfig = copyLPConfigWithOverrides(lpConfig, {
                    liquidityCap: liquidityCap,
                });
                await poolConfigContract.connect(poolOwner).setLPConfig(newLpConfig);
                const eaOperatorConfig =
                    await poolOwnerAndEAFirstLossCoverContract.operatorConfigs(
                        evaluationAgent2.getAddress(),
                    );
                firstLossCoverAmount = liquidityCap
                    .mul(eaOperatorConfig.poolValueCoverageInBps)
                    .div(10000);
            });

            it("Should allow evaluation agent to be replaced", async function () {
                // Give the new EA some tokens to use as the first loss cover.
                await mockTokenContract.mint(evaluationAgent2.address, firstLossCoverAmount);
                await mockTokenContract
                    .connect(evaluationAgent2)
                    .approve(poolOwnerAndEAFirstLossCoverContract.address, firstLossCoverAmount);
                await poolOwnerAndEAFirstLossCoverContract
                    .connect(evaluationAgent2)
                    .addCover(firstLossCoverAmount);

                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setEvaluationAgent(newNFTTokenId, evaluationAgent2.address),
                )
                    .to.emit(poolConfigContract, "EvaluationAgentChanged")
                    .withArgs(
                        evaluationAgent.address,
                        evaluationAgent2.address,
                        newNFTTokenId,
                        poolOwner.address,
                    );
                expect(await poolConfigContract.evaluationAgent()).to.equal(
                    evaluationAgent2.address,
                );
                expect(await poolConfigContract.evaluationAgentId()).to.equal(newNFTTokenId);
            });

            it("Should reject zero address EA", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setEvaluationAgent(newNFTTokenId, ethers.constants.AddressZero),
                ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
            });

            it("Should not allow non-pool owners or Huma master admin to set the EA", async function () {
                await expect(
                    poolConfigContract
                        .connect(regularUser)
                        .setEvaluationAgent(newNFTTokenId, evaluationAgent2.address),
                ).to.be.revertedWithCustomError(poolConfigContract, "permissionDeniedNotAdmin");
            });

            it("Should reject when the proposed new EA does not own the EA NFT", async function () {
                let yetAnotherNFTTokenId;
                const tx = await eaNFTContract.mintNFT(evaluationAgent.address);
                const receipt = await tx.wait();
                for (const evt of receipt.events!) {
                    if (evt.event === "NFTGenerated") {
                        yetAnotherNFTTokenId = evt.args!.tokenId;
                    }
                }

                await mockTokenContract.mint(evaluationAgent2.address, firstLossCoverAmount);
                await mockTokenContract
                    .connect(evaluationAgent2)
                    .approve(poolOwnerAndEAFirstLossCoverContract.address, firstLossCoverAmount);
                await poolOwnerAndEAFirstLossCoverContract
                    .connect(evaluationAgent2)
                    .addCover(firstLossCoverAmount);
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setEvaluationAgent(yetAnotherNFTTokenId, evaluationAgent2.address),
                ).to.revertedWithCustomError(
                    poolConfigContract,
                    "proposedEADoesNotOwnProvidedEANFT",
                );
            });

            it("Should reject when the new evaluation agent has not met the first loss cover requirements", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setEvaluationAgent(newNFTTokenId, evaluationAgent2.address),
                ).to.be.revertedWithCustomError(poolConfigContract, "lessThanRequiredCover");
            });
        });

        // it("setPoolName", async function () {
        //     const poolName = "TestPoolName";
        //     await poolConfigContract.setPoolName(poolName);
        //     expect(await poolConfigContract.poolName()).to.equal(poolName);
        // });
    });
});
