import { ethers } from "hardhat";

import { expect } from "chai";
import { CONSTANTS, deployAndSetupPoolContracts, deployProtocolContracts } from "./BaseTest";
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
    PoolFeeManager,
    Pool,
    PoolConfig,
    PoolSafe,
    RiskAdjustedTranchesPolicy,
    TrancheVault,
    ProfitEscrow,
} from "../typechain-types";
import {
    getMinFirstLossCoverRequirement,
    getMinLiquidityRequirementForEA,
    getMinLiquidityRequirementForPoolOwner,
    toToken,
} from "./TestUtils";
import { BigNumber as BN } from "ethers";
import {
    FeeStructureStruct,
    FrontLoadingFeesStructureStruct,
    LPConfigStruct,
} from "../typechain-types/contracts/PoolConfig.sol/PoolConfig";

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
    poolFeeManagerContract: PoolFeeManager,
    poolSafeContract: PoolSafe,
    calendarContract: Calendar,
    borrowerFirstLossCoverContract: FirstLossCover,
    affiliateFirstLossCoverContract: FirstLossCover,
    affiliateFirstLossCoverProfitEscrowContract: ProfitEscrow,
    tranchesPolicyContract: RiskAdjustedTranchesPolicy,
    poolContract: Pool,
    epochManagerContract: EpochManager,
    seniorTrancheVaultContract: TrancheVault,
    juniorTrancheVaultContract: TrancheVault,
    creditContract: MockPoolCredit,
    creditFeeManagerContract: BaseCreditFeeManager,
    creditPnlManagerContract: BasePnLManager;

describe("PoolConfig Tests", function () {
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

    describe("Pool config initialization", function () {
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

            const PoolFeeManager = await ethers.getContractFactory("PoolFeeManager");
            poolFeeManagerContract = await PoolFeeManager.deploy();
            await poolFeeManagerContract.deployed();

            const PoolSafe = await ethers.getContractFactory("PoolSafe");
            poolSafeContract = await PoolSafe.deploy();
            await poolSafeContract.deployed();

            const FirstLossCover = await ethers.getContractFactory("FirstLossCover");
            borrowerFirstLossCoverContract = await FirstLossCover.deploy();
            await borrowerFirstLossCoverContract.deployed();
            affiliateFirstLossCoverContract = await FirstLossCover.deploy();
            await affiliateFirstLossCoverContract.deployed();

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

        it("Should initialize successfully and sets default values", async function () {
            await poolConfigContract
                .connect(poolOwner)
                .initialize("Base Credit Pool", [
                    humaConfigContract.address,
                    mockTokenContract.address,
                    calendarContract.address,
                    poolContract.address,
                    poolSafeContract.address,
                    poolFeeManagerContract.address,
                    tranchesPolicyContract.address,
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
            expect(poolSettings.receivableRequiredInBps).to.equal(10000);
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
                        poolFeeManagerContract.address,
                        poolSafeContract.address,
                        calendarContract.address,
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
                        poolFeeManagerContract.address,
                        poolSafeContract.address,
                        calendarContract.address,
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
                        poolFeeManagerContract.address,
                        poolSafeContract.address,
                        calendarContract.address,
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

        it("Should reject zero address for poolFeeManager", async function () {
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize("Base Credit Pool", [
                        humaConfigContract.address,
                        mockTokenContract.address,
                        ethers.constants.AddressZero,
                        poolSafeContract.address,
                        calendarContract.address,
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

        it("Should reject zero address for poolSafe", async function () {
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize("Base Credit Pool", [
                        humaConfigContract.address,
                        mockTokenContract.address,
                        poolFeeManagerContract.address,
                        ethers.constants.AddressZero,
                        calendarContract.address,
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
                        poolFeeManagerContract.address,
                        poolSafeContract.address,
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

        it("Should reject zero address for poolOwnerOrEAFirstLossCover", async function () {
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize("Base Credit Pool", [
                        humaConfigContract.address,
                        mockTokenContract.address,
                        poolFeeManagerContract.address,
                        poolSafeContract.address,
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
                        poolFeeManagerContract.address,
                        poolSafeContract.address,
                        calendarContract.address,
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
                        poolFeeManagerContract.address,
                        poolSafeContract.address,
                        calendarContract.address,
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
                        poolFeeManagerContract.address,
                        poolSafeContract.address,
                        calendarContract.address,
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
                        poolFeeManagerContract.address,
                        poolSafeContract.address,
                        calendarContract.address,
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
                        poolFeeManagerContract.address,
                        poolSafeContract.address,
                        calendarContract.address,
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
                        poolFeeManagerContract.address,
                        poolSafeContract.address,
                        calendarContract.address,
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
                        poolFeeManagerContract.address,
                        poolSafeContract.address,
                        calendarContract.address,
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
                        poolFeeManagerContract.address,
                        poolSafeContract.address,
                        calendarContract.address,
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
                    poolFeeManagerContract.address,
                    poolSafeContract.address,
                    calendarContract.address,
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
                        poolFeeManagerContract.address,
                        poolSafeContract.address,
                        calendarContract.address,
                        tranchesPolicyContract.address,
                        poolContract.address,
                        epochManagerContract.address,
                        seniorTrancheVaultContract.address,
                        juniorTrancheVaultContract.address,
                        creditContract.address,
                        creditFeeManagerContract.address,
                        creditPnlManagerContract.address,
                    ]),
            ).to.be.revertedWith("Initializable: contract is already initialized");
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
                poolFeeManagerContract,
                poolSafeContract,
                calendarContract,
                borrowerFirstLossCoverContract,
                affiliateFirstLossCoverContract,
                affiliateFirstLossCoverProfitEscrowContract,
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
                [regularUser, evaluationAgent2],
            );
        }

        beforeEach(async function () {
            await loadFixture(deployAndSetupContracts);
        });

        describe("setYield", function () {
            const yieldInBps = 1000;

            it("Should allow the pool owner set the yield for the pool", async function () {
                await expect(poolConfigContract.connect(poolOwner).setYield(yieldInBps))
                    .to.emit(poolConfigContract, "YieldChanged")
                    .withArgs(yieldInBps, poolOwner.address);
                const poolSummary = await poolConfigContract.getPoolSummary();
                expect(poolSummary[1]).to.equal(yieldInBps);
            });

            it("Should allow the Huma master admin set the yield for the pool", async function () {
                await expect(poolConfigContract.connect(protocolOwner).setYield(yieldInBps))
                    .to.emit(poolConfigContract, "YieldChanged")
                    .withArgs(yieldInBps, protocolOwner.address);
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

            it("Should allow the pool owner set the credit approval expiration", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setCreditApprovalExpiration(durationInDays),
                )
                    .to.emit(poolConfigContract, "CreditApprovalExpirationChanged")
                    .withArgs(durationInDays, poolOwner.address);
                const poolSettings = await poolConfigContract.getPoolSettings();
                expect(poolSettings[3]).to.equal(durationInDays);
            });

            it("Should allow the Huma master admin set the credit approval expiration", async function () {
                await expect(
                    poolConfigContract
                        .connect(protocolOwner)
                        .setCreditApprovalExpiration(durationInDays),
                )
                    .to.emit(poolConfigContract, "CreditApprovalExpirationChanged")
                    .withArgs(durationInDays, protocolOwner.address);
                const poolSettings = await poolConfigContract.getPoolSettings();
                expect(poolSettings[3]).to.equal(durationInDays);
            });

            it("Should reject non-owner or non-Huma master admin", async function () {
                await expect(
                    poolConfigContract
                        .connect(regularUser)
                        .setCreditApprovalExpiration(durationInDays),
                ).to.be.revertedWithCustomError(poolConfigContract, "permissionDeniedNotAdmin");
            });
        });

        describe("setLatePaymentGracePeriodInDays", function () {
            const gracePeriodInDays = 5;

            it("Should allow the pool owner set the late payment period", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setLatePaymentGracePeriodInDays(gracePeriodInDays),
                )
                    .to.emit(poolConfigContract, "LatePaymentGracePeriodChanged")
                    .withArgs(gracePeriodInDays, poolOwner.address);
                const poolSettings = await poolConfigContract.getPoolSettings();
                expect(poolSettings[4]).to.equal(gracePeriodInDays);
            });

            it("Should allow the Huma master admin set the late payment periodl", async function () {
                await expect(
                    poolConfigContract
                        .connect(protocolOwner)
                        .setLatePaymentGracePeriodInDays(gracePeriodInDays),
                )
                    .to.emit(poolConfigContract, "LatePaymentGracePeriodChanged")
                    .withArgs(gracePeriodInDays, protocolOwner.address);
                const poolSettings = await poolConfigContract.getPoolSettings();
                expect(poolSettings[4]).to.equal(gracePeriodInDays);
            });

            it("Should reject non-owner or non-Huma master admin", async function () {
                await expect(
                    poolConfigContract
                        .connect(regularUser)
                        .setLatePaymentGracePeriodInDays(gracePeriodInDays),
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
            let newNFTTokenId: string;
            let firstLossCoverAmount: BN, minLiquidity: BN;

            beforeEach(async function () {
                const tx = await eaNFTContract.mintNFT(evaluationAgent2.address);
                const receipt = await tx.wait();
                for (const evt of receipt.events!) {
                    if (evt.event === "NFTGenerated") {
                        newNFTTokenId = evt.args!.tokenId;
                    }
                }

                // Set the EA to be an operator.
                await affiliateFirstLossCoverContract
                    .connect(poolOwner)
                    .setOperator(evaluationAgent2.getAddress(), {
                        poolCapCoverageInBps: 100,
                        poolValueCoverageInBps: 100,
                    });

                firstLossCoverAmount = await getMinFirstLossCoverRequirement(
                    affiliateFirstLossCoverContract,
                    poolConfigContract,
                    poolContract,
                    evaluationAgent2.address,
                );
                minLiquidity = await getMinLiquidityRequirementForEA(poolConfigContract);
            });

            it("Should allow the evaluation agent to be replaced", async function () {
                // Give the new EA some tokens to use as the first loss cover and junior tranche liquidity.
                await mockTokenContract.mint(
                    evaluationAgent2.address,
                    firstLossCoverAmount.add(minLiquidity),
                );
                await mockTokenContract
                    .connect(evaluationAgent2)
                    .approve(poolSafeContract.address, firstLossCoverAmount.add(minLiquidity));
                await affiliateFirstLossCoverContract
                    .connect(evaluationAgent2)
                    .depositCover(firstLossCoverAmount);
                await juniorTrancheVaultContract
                    .connect(evaluationAgent2)
                    .deposit(minLiquidity, evaluationAgent2.address);

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
                    .approve(poolSafeContract.address, firstLossCoverAmount);
                await affiliateFirstLossCoverContract
                    .connect(evaluationAgent2)
                    .depositCover(firstLossCoverAmount);
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setEvaluationAgent(yetAnotherNFTTokenId, evaluationAgent2.address),
                ).to.be.revertedWithCustomError(
                    poolConfigContract,
                    "proposedEADoesNotOwnProvidedEANFT",
                );
            });

            it("Should reject when the new evaluation agent has not met the first loss cover requirement", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setEvaluationAgent(newNFTTokenId, evaluationAgent2.address),
                ).to.be.revertedWithCustomError(poolConfigContract, "lessThanRequiredCover");
            });

            it("Should reject when the new evaluation agent has not met the liquidity requirement", async function () {
                await mockTokenContract.mint(evaluationAgent2.address, firstLossCoverAmount);
                await mockTokenContract
                    .connect(evaluationAgent2)
                    .approve(poolSafeContract.address, firstLossCoverAmount);
                await affiliateFirstLossCoverContract
                    .connect(evaluationAgent2)
                    .depositCover(firstLossCoverAmount);

                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setEvaluationAgent(newNFTTokenId, evaluationAgent2.address),
                ).to.be.revertedWithCustomError(
                    poolConfigContract,
                    "evaluationAgentNotEnoughLiquidity",
                );
            });
        });

        describe("setPoolFeeManager", function () {
            it("Should allow pool owner to set the fee manager successfully", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setPoolFeeManager(poolFeeManagerContract.address),
                )
                    .to.emit(poolConfigContract, "PoolFeeManagerChanged")
                    .withArgs(poolFeeManagerContract.address, poolOwner.address);
                expect(await poolConfigContract.poolFeeManager()).to.equal(
                    poolFeeManagerContract.address,
                );
            });

            it("Should allow protocol owner to set the fee manager successfully", async function () {
                await expect(
                    poolConfigContract
                        .connect(protocolOwner)
                        .setPoolFeeManager(poolFeeManagerContract.address),
                )
                    .to.emit(poolConfigContract, "PoolFeeManagerChanged")
                    .withArgs(poolFeeManagerContract.address, protocolOwner.address);
                expect(await poolConfigContract.poolFeeManager()).to.equal(
                    poolFeeManagerContract.address,
                );
            });

            it("Should reject non-owner and admin to call setPoolFeeManager", async function () {
                await expect(
                    poolConfigContract
                        .connect(regularUser)
                        .setPoolFeeManager(poolFeeManagerContract.address),
                ).to.be.revertedWithCustomError(poolConfigContract, "permissionDeniedNotAdmin");
            });

            it("Should reject fee manager with zero address", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setPoolFeeManager(ethers.constants.AddressZero),
                ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
            });
        });

        describe("setHumaConfig", function () {
            it("Should allow the pool owner to set Huma config", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setHumaConfig(humaConfigContract.address),
                )
                    .to.emit(poolConfigContract, "HumaConfigChanged")
                    .withArgs(humaConfigContract.address, poolOwner.address);
                expect(await poolConfigContract.humaConfig()).to.equal(humaConfigContract.address);
            });

            it("Should allow the Huma master admin to set Huma config", async function () {
                await expect(
                    poolConfigContract
                        .connect(protocolOwner)
                        .setHumaConfig(humaConfigContract.address),
                )
                    .to.emit(poolConfigContract, "HumaConfigChanged")
                    .withArgs(humaConfigContract.address, protocolOwner.address);
                expect(await poolConfigContract.humaConfig()).to.equal(humaConfigContract.address);
            });

            it("Should reject non-owner or admin to call setHumaConfig", async function () {
                await expect(
                    poolConfigContract
                        .connect(regularUser)
                        .setHumaConfig(humaConfigContract.address),
                ).to.be.revertedWithCustomError(poolConfigContract, "permissionDeniedNotAdmin");
            });

            it("Should reject Huma config with zero address", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setHumaConfig(ethers.constants.AddressZero),
                ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
            });
        });

        describe("setMaxCreditLine", function () {
            let maxCreditLine: BN;

            before(function () {
                maxCreditLine = toToken(5_000);
            });

            it("Should allow the pool owner to set the max credit line", async function () {
                await expect(poolConfigContract.connect(poolOwner).setMaxCreditLine(maxCreditLine))
                    .to.emit(poolConfigContract, "MaxCreditLineChanged")
                    .withArgs(maxCreditLine, poolOwner.address);
                const poolSummary = await poolConfigContract.getPoolSummary();
                expect(poolSummary[3]).to.equal(maxCreditLine);
            });

            it("Should allow the Huma master admin to set the max credit line", async function () {
                await expect(
                    poolConfigContract.connect(protocolOwner).setMaxCreditLine(maxCreditLine),
                )
                    .to.emit(poolConfigContract, "MaxCreditLineChanged")
                    .withArgs(maxCreditLine, protocolOwner.address);
                const poolSummary = await poolConfigContract.getPoolSummary();
                expect(poolSummary[3]).to.equal(maxCreditLine);
            });

            it("Should reject non-owner or admin to set the max credit line", async function () {
                await expect(
                    poolConfigContract.connect(regularUser).setMaxCreditLine(maxCreditLine),
                ).to.be.revertedWithCustomError(poolConfigContract, "permissionDeniedNotAdmin");
            });

            it("Should reject zero as the max credit line", async function () {
                await expect(
                    poolConfigContract.connect(poolOwner).setMaxCreditLine(0),
                ).to.be.revertedWithCustomError(poolConfigContract, "zeroAmountProvided");
            });

            it("Should reject a max credit line that's too high", async function () {
                await expect(
                    poolConfigContract.connect(poolOwner).setMaxCreditLine(BN.from(2).pow(96)),
                ).to.be.revertedWithCustomError(poolConfigContract, "creditLineTooHigh");
            });
        });

        describe("setPool", function () {
            it("Should allow the pool owner to set the pool", async function () {
                await expect(poolConfigContract.connect(poolOwner).setPool(poolContract.address))
                    .to.emit(poolConfigContract, "PoolChanged")
                    .withArgs(poolContract.address, poolOwner.address);
                expect(await poolConfigContract.pool()).to.equal(poolContract.address);
            });

            it("Should allow the Huma master admin to set the pool", async function () {
                await expect(
                    poolConfigContract.connect(protocolOwner).setPool(poolContract.address),
                )
                    .to.emit(poolConfigContract, "PoolChanged")
                    .withArgs(poolContract.address, protocolOwner.address);
                expect(await poolConfigContract.pool()).to.equal(poolContract.address);
            });

            it("Should reject non-owner or admin to set the pool", async function () {
                await expect(
                    poolConfigContract.connect(regularUser).setPool(poolContract.address),
                ).to.be.revertedWithCustomError(poolConfigContract, "permissionDeniedNotAdmin");
            });

            it("Should reject pools with zero address", async function () {
                await expect(
                    poolConfigContract.connect(poolOwner).setPool(ethers.constants.AddressZero),
                ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
            });
        });

        describe("setPoolDefaultGracePeriod", function () {
            let defaultGracePeriodDays: number, calendarUnit: number;

            before(function () {
                defaultGracePeriodDays = 30;
                calendarUnit = CONSTANTS.CALENDAR_UNIT_DAY;
            });

            it("Should allow the pool owner to set the default grace period", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setPoolDefaultGracePeriod(calendarUnit, defaultGracePeriodDays),
                )
                    .to.emit(poolConfigContract, "PoolDefaultGracePeriodChanged")
                    .withArgs(calendarUnit, defaultGracePeriodDays, poolOwner.address);
                const poolSettings = await poolConfigContract.getPoolSettings();
                expect(poolSettings.defaultGracePeriodInCalendarUnit).to.equal(
                    defaultGracePeriodDays,
                );
            });

            it("Should allow the Huma master admin to set the default grace period", async function () {
                await expect(
                    poolConfigContract
                        .connect(protocolOwner)
                        .setPoolDefaultGracePeriod(calendarUnit, defaultGracePeriodDays),
                )
                    .to.emit(poolConfigContract, "PoolDefaultGracePeriodChanged")
                    .withArgs(calendarUnit, defaultGracePeriodDays, protocolOwner.address);
                const poolSettings = await poolConfigContract.getPoolSettings();
                expect(poolSettings.calendarUnit).to.equal(calendarUnit);
            });

            it("Should reject non-owner or admin to set the default grace period", async function () {
                await expect(
                    poolConfigContract
                        .connect(regularUser)
                        .setPoolDefaultGracePeriod(calendarUnit, defaultGracePeriodDays),
                ).to.be.revertedWithCustomError(poolConfigContract, "permissionDeniedNotAdmin");
            });

            it("Should reject new default grace period with the wrong calendar unit", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setPoolDefaultGracePeriod(
                            CONSTANTS.CALENDAR_UNIT_MONTH,
                            defaultGracePeriodDays,
                        ),
                ).to.be.revertedWithCustomError(poolConfigContract, "invalidCalendarUnit");
            });
        });

        describe("setPoolLiquidityCap", function () {
            let liquidityCap: BN;

            before(function () {
                liquidityCap = toToken(50_000_000);
            });

            it("Should allow the pool owner to set the liquidity cap", async function () {
                await expect(
                    poolConfigContract.connect(poolOwner).setPoolLiquidityCap(liquidityCap),
                )
                    .to.emit(poolConfigContract, "PoolLiquidityCapChanged")
                    .withArgs(liquidityCap, poolOwner.address);
                const lpConfig = await poolConfigContract.getLPConfig();
                expect(lpConfig.liquidityCap).to.equal(liquidityCap);
            });

            it("Should allow the Huma master admin to set the liquidity cap", async function () {
                await expect(
                    poolConfigContract.connect(protocolOwner).setPoolLiquidityCap(liquidityCap),
                )
                    .to.emit(poolConfigContract, "PoolLiquidityCapChanged")
                    .withArgs(liquidityCap, protocolOwner.address);
                const lpConfig = await poolConfigContract.getLPConfig();
                expect(lpConfig.liquidityCap).to.equal(liquidityCap);
            });

            it("Should reject non-owner or admin to set the liquidity cap", async function () {
                await expect(
                    poolConfigContract.connect(regularUser).setPoolLiquidityCap(liquidityCap),
                ).to.be.revertedWithCustomError(poolConfigContract, "permissionDeniedNotAdmin");
            });

            it("Should reject zero liquidity cap", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setPoolLiquidityCap(ethers.constants.Zero),
                ).to.be.revertedWithCustomError(poolConfigContract, "zeroAmountProvided");
            });
        });

        describe("setPoolPayPeriod", function () {
            let calendarUnit: number, numPayPeriods: number;

            before(function () {
                calendarUnit = CONSTANTS.CALENDAR_UNIT_MONTH;
                numPayPeriods = 1;
            });

            it("Should allow the pool owner to set the pay period", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setPoolPayPeriod(calendarUnit, numPayPeriods),
                )
                    .to.emit(poolConfigContract, "PoolPayPeriodChanged")
                    .withArgs(calendarUnit, numPayPeriods, poolOwner.address);
                const poolSettings = await poolConfigContract.getPoolSettings();
                expect(poolSettings.calendarUnit).to.equal(calendarUnit);
                expect(poolSettings.payPeriodInCalendarUnit).to.equal(numPayPeriods);
            });

            it("Should allow the Huma master admin to set the pay period", async function () {
                await expect(
                    poolConfigContract
                        .connect(protocolOwner)
                        .setPoolPayPeriod(calendarUnit, numPayPeriods),
                )
                    .to.emit(poolConfigContract, "PoolPayPeriodChanged")
                    .withArgs(calendarUnit, numPayPeriods, protocolOwner.address);
                const poolSettings = await poolConfigContract.getPoolSettings();
                expect(poolSettings.calendarUnit).to.equal(calendarUnit);
                expect(poolSettings.payPeriodInCalendarUnit).to.equal(numPayPeriods);
            });

            it("Should reject non-owner or admin to set the pool", async function () {
                await expect(
                    poolConfigContract
                        .connect(regularUser)
                        .setPoolPayPeriod(calendarUnit, numPayPeriods),
                ).to.be.revertedWithCustomError(poolConfigContract, "permissionDeniedNotAdmin");
            });

            it("Should reject zero pay periods", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setPoolPayPeriod(calendarUnit, ethers.constants.Zero),
                ).to.be.revertedWithCustomError(poolConfigContract, "zeroAmountProvided");
            });
        });

        describe("setPoolFlexCall", function () {
            let enabled = true,
                flexCallWindowInEpoch = 3;
            it("Should allow the pool owner to set the flex call config", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setPoolFlexCall(enabled, flexCallWindowInEpoch),
                )
                    .to.emit(poolConfigContract, "PoolFlexCallChanged")
                    .withArgs(enabled, flexCallWindowInEpoch, poolOwner.address);
                expect(await poolConfigContract.pool()).to.equal(poolContract.address);
            });

            it("Should allow the Huma master admin to set the flex call config", async function () {
                await expect(
                    poolConfigContract
                        .connect(protocolOwner)
                        .setPoolFlexCall(enabled, flexCallWindowInEpoch),
                )
                    .to.emit(poolConfigContract, "PoolFlexCallChanged")
                    .withArgs(enabled, flexCallWindowInEpoch, protocolOwner.address);
                expect(await poolConfigContract.pool()).to.equal(poolContract.address);
            });

            it("Should reject non-owner or admin to set the flex call config", async function () {
                await expect(
                    poolConfigContract
                        .connect(regularUser)
                        .setPoolFlexCall(enabled, flexCallWindowInEpoch),
                ).to.be.revertedWithCustomError(poolConfigContract, "permissionDeniedNotAdmin");
            });

            it("Should reject zero-valued windows", async function () {
                await expect(
                    poolConfigContract.connect(poolOwner).setPoolFlexCall(enabled, 0),
                ).to.be.revertedWithCustomError(poolConfigContract, "zeroAmountProvided");
            });
        });

        describe("setPoolName", function () {
            const poolName = "Test pool";

            it("Should allow the pool owner to set pool name", async function () {
                await expect(poolConfigContract.connect(poolOwner).setPoolName(poolName))
                    .to.emit(poolConfigContract, "PoolNameChanged")
                    .withArgs(poolName, poolOwner.address);
                expect(await poolConfigContract.poolName()).to.equal(poolName);
            });

            it("Should allow the Huma master admin to set pool name", async function () {
                await expect(poolConfigContract.connect(protocolOwner).setPoolName(poolName))
                    .to.emit(poolConfigContract, "PoolNameChanged")
                    .withArgs(poolName, protocolOwner.address);
                expect(await poolConfigContract.poolName()).to.equal(poolName);
            });

            it("Should reject non-owner or admin to call setPoolName", async function () {
                await expect(
                    poolConfigContract.connect(regularUser).setPoolName(poolName),
                ).to.be.revertedWithCustomError(poolConfigContract, "permissionDeniedNotAdmin");
            });
        });

        describe("setPoolOwnerTreasury", function () {
            it("Should allow the pool owner to call setPoolOwnerTreasury", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setPoolOwnerTreasury(poolOwnerTreasury.address),
                )
                    .to.emit(poolConfigContract, "PoolOwnerTreasuryChanged")
                    .withArgs(poolOwnerTreasury.address, poolOwner.address);
                expect(await poolConfigContract.poolOwnerTreasury()).to.equal(
                    poolOwnerTreasury.address,
                );
            });

            it("Should allow the Huma master admin to call setPoolOwnerTreasury", async function () {
                await expect(
                    poolConfigContract
                        .connect(protocolOwner)
                        .setPoolOwnerTreasury(poolOwnerTreasury.address),
                )
                    .to.emit(poolConfigContract, "PoolOwnerTreasuryChanged")
                    .withArgs(poolOwnerTreasury.address, protocolOwner.address);
                expect(await poolConfigContract.poolOwnerTreasury()).to.equal(
                    poolOwnerTreasury.address,
                );
            });

            it("Should reject non-owner or admin to call setPoolOwnerTreasury", async function () {
                await expect(
                    poolConfigContract
                        .connect(regularUser)
                        .setPoolOwnerTreasury(poolOwnerTreasury.address),
                ).to.be.revertedWithCustomError(poolConfigContract, "permissionDeniedNotAdmin");
            });

            it("Should disallow zero address for pool owner treasury", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setPoolOwnerTreasury(ethers.constants.AddressZero),
                ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
            });
        });

        describe("setTranches", function () {
            it("Should allow the pool owner to set the tranches", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setTranches(
                            seniorTrancheVaultContract.address,
                            juniorTrancheVaultContract.address,
                        ),
                )
                    .to.emit(poolConfigContract, "TranchesChanged")
                    .withArgs(
                        seniorTrancheVaultContract.address,
                        juniorTrancheVaultContract.address,
                        poolOwner.address,
                    );
                expect(await poolConfigContract.seniorTranche()).to.equal(
                    seniorTrancheVaultContract.address,
                );
                expect(await poolConfigContract.juniorTranche()).to.equal(
                    juniorTrancheVaultContract.address,
                );
            });

            it("Should allow the Huma master admin to set the tranches", async function () {
                await expect(
                    poolConfigContract
                        .connect(protocolOwner)
                        .setTranches(
                            seniorTrancheVaultContract.address,
                            juniorTrancheVaultContract.address,
                        ),
                )
                    .to.emit(poolConfigContract, "TranchesChanged")
                    .withArgs(
                        seniorTrancheVaultContract.address,
                        juniorTrancheVaultContract.address,
                        protocolOwner.address,
                    );
                expect(await poolConfigContract.seniorTranche()).to.equal(
                    seniorTrancheVaultContract.address,
                );
                expect(await poolConfigContract.juniorTranche()).to.equal(
                    juniorTrancheVaultContract.address,
                );
            });

            it("Should reject non-owner or admin to set the tranches", async function () {
                await expect(
                    poolConfigContract
                        .connect(regularUser)
                        .setTranches(
                            seniorTrancheVaultContract.address,
                            juniorTrancheVaultContract.address,
                        ),
                ).to.be.revertedWithCustomError(poolConfigContract, "permissionDeniedNotAdmin");
            });

            it("Should disallow zero addresses for the senior tranche", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setTranches(
                            ethers.constants.AddressZero,
                            juniorTrancheVaultContract.address,
                        ),
                ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
            });

            it("Should disallow zero addresses for the junior tranche", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setTranches(
                            seniorTrancheVaultContract.address,
                            ethers.constants.AddressZero,
                        ),
                ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
            });
        });

        describe("setPoolSafe", function () {
            it("Should allow the pool owner to set the pool safe", async function () {
                await expect(
                    poolConfigContract.connect(poolOwner).setPoolSafe(poolSafeContract.address),
                )
                    .to.emit(poolConfigContract, "PoolSafeChanged")
                    .withArgs(poolSafeContract.address, poolOwner.address);
                expect(await poolConfigContract.poolSafe()).to.equal(poolSafeContract.address);
            });

            it("Should allow the Huma master admin to set the pool safe", async function () {
                await expect(
                    poolConfigContract
                        .connect(protocolOwner)
                        .setPoolSafe(poolSafeContract.address),
                )
                    .to.emit(poolConfigContract, "PoolSafeChanged")
                    .withArgs(poolSafeContract.address, protocolOwner.address);
                expect(await poolConfigContract.poolSafe()).to.equal(poolSafeContract.address);
            });

            it("Should reject non-owner or admin to set the pool safe", async function () {
                await expect(
                    poolConfigContract.connect(regularUser).setPoolSafe(poolSafeContract.address),
                ).to.be.revertedWithCustomError(poolConfigContract, "permissionDeniedNotAdmin");
            });

            it("Should disallow zero address for the pool safe", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setPoolSafe(ethers.constants.AddressZero),
                ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
            });
        });

        describe("setTranchesPolicy", function () {
            it("Should allow the pool owner to set the tranches policy", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setTranchesPolicy(tranchesPolicyContract.address),
                )
                    .to.emit(poolConfigContract, "TranchesPolicyChanged")
                    .withArgs(tranchesPolicyContract.address, poolOwner.address);
                expect(await poolConfigContract.tranchesPolicy()).to.equal(
                    tranchesPolicyContract.address,
                );
            });

            it("Should allow the Huma master admin to set the tranches policy", async function () {
                await expect(
                    poolConfigContract
                        .connect(protocolOwner)
                        .setTranchesPolicy(tranchesPolicyContract.address),
                )
                    .to.emit(poolConfigContract, "TranchesPolicyChanged")
                    .withArgs(tranchesPolicyContract.address, protocolOwner.address);
                expect(await poolConfigContract.tranchesPolicy()).to.equal(
                    tranchesPolicyContract.address,
                );
            });

            it("Should reject non-owner or admin to set the tranches policy", async function () {
                await expect(
                    poolConfigContract
                        .connect(regularUser)
                        .setTranchesPolicy(tranchesPolicyContract.address),
                ).to.be.revertedWithCustomError(poolConfigContract, "permissionDeniedNotAdmin");
            });

            it("Should disallow zero address for the tranches policy", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setTranchesPolicy(ethers.constants.AddressZero),
                ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
            });
        });

        describe("setEpochManager", function () {
            it("Should allow the pool owner to set the epoch manager", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setEpochManager(epochManagerContract.address),
                )
                    .to.emit(poolConfigContract, "EpochManagerChanged")
                    .withArgs(epochManagerContract.address, poolOwner.address);
                expect(await poolConfigContract.epochManager()).to.equal(
                    epochManagerContract.address,
                );
            });

            it("Should allow the Huma master admin to set the epoch manager", async function () {
                await expect(
                    poolConfigContract
                        .connect(protocolOwner)
                        .setEpochManager(epochManagerContract.address),
                )
                    .to.emit(poolConfigContract, "EpochManagerChanged")
                    .withArgs(epochManagerContract.address, protocolOwner.address);
                expect(await poolConfigContract.epochManager()).to.equal(
                    epochManagerContract.address,
                );
            });

            it("Should reject non-owner or admin to set the epoch manager", async function () {
                await expect(
                    poolConfigContract
                        .connect(regularUser)
                        .setEpochManager(epochManagerContract.address),
                ).to.be.revertedWithCustomError(poolConfigContract, "permissionDeniedNotAdmin");
            });

            it("Should disallow zero address for the epoch manager", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setEpochManager(ethers.constants.AddressZero),
                ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
            });
        });

        describe("setCredit", function () {
            it("Should allow the pool owner to set the credit contract", async function () {
                await expect(
                    poolConfigContract.connect(poolOwner).setCredit(creditContract.address),
                )
                    .to.emit(poolConfigContract, "CreditChanged")
                    .withArgs(creditContract.address, poolOwner.address);
                expect(await poolConfigContract.credit()).to.equal(creditContract.address);
            });

            it("Should allow the Huma master admin to set the credit contract", async function () {
                await expect(
                    poolConfigContract.connect(protocolOwner).setCredit(creditContract.address),
                )
                    .to.emit(poolConfigContract, "CreditChanged")
                    .withArgs(creditContract.address, protocolOwner.address);
                expect(await poolConfigContract.credit()).to.equal(creditContract.address);
            });

            it("Should reject non-owner or admin to set the credit contract", async function () {
                await expect(
                    poolConfigContract.connect(regularUser).setCredit(creditContract.address),
                ).to.be.revertedWithCustomError(poolConfigContract, "permissionDeniedNotAdmin");
            });

            it("Should disallow zero address for the credit contract", async function () {
                await expect(
                    poolConfigContract.connect(poolOwner).setCredit(ethers.constants.AddressZero),
                ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
            });
        });

        // TODO(jiatu): add first loss cover setter tests after it's updated.
        describe("setCalendar", function () {
            it("Should allow the pool owner to set the calendar contract", async function () {
                await expect(
                    poolConfigContract.connect(poolOwner).setCalendar(calendarContract.address),
                )
                    .to.emit(poolConfigContract, "CalendarChanged")
                    .withArgs(calendarContract.address, poolOwner.address);
                expect(await poolConfigContract.calendar()).to.equal(calendarContract.address);
            });

            it("Should allow the Huma master admin to set the calendar contract", async function () {
                await expect(
                    poolConfigContract
                        .connect(protocolOwner)
                        .setCalendar(calendarContract.address),
                )
                    .to.emit(poolConfigContract, "CalendarChanged")
                    .withArgs(calendarContract.address, protocolOwner.address);
                expect(await poolConfigContract.calendar()).to.equal(calendarContract.address);
            });

            it("Should reject non-owner or admin to set the calendar contract", async function () {
                await expect(
                    poolConfigContract.connect(regularUser).setCalendar(calendarContract.address),
                ).to.be.revertedWithCustomError(poolConfigContract, "permissionDeniedNotAdmin");
            });

            it("Should disallow zero address for the calendar contract", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setCalendar(ethers.constants.AddressZero),
                ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
            });
        });

        describe("setReceivableRequiredInBps", function () {
            let receivableRequiredInBps = 10_100;

            it("Should allow the pool owner to set the receivable requirement rate", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setReceivableRequiredInBps(receivableRequiredInBps),
                )
                    .to.emit(poolConfigContract, "ReceivableRequiredInBpsChanged")
                    .withArgs(receivableRequiredInBps, poolOwner.address);
                const poolSettings = await poolConfigContract.getPoolSettings();
                expect(poolSettings.receivableRequiredInBps).to.equal(receivableRequiredInBps);
            });

            it("Should allow the Huma master admin to set the receivable requirement rate", async function () {
                await expect(
                    poolConfigContract
                        .connect(protocolOwner)
                        .setReceivableRequiredInBps(receivableRequiredInBps),
                )
                    .to.emit(poolConfigContract, "ReceivableRequiredInBpsChanged")
                    .withArgs(receivableRequiredInBps, protocolOwner.address);
                const poolSettings = await poolConfigContract.getPoolSettings();
                expect(poolSettings.receivableRequiredInBps).to.equal(receivableRequiredInBps);
            });

            it("Should reject non-owner or admin to set the receivable requirement rate", async function () {
                await expect(
                    poolConfigContract
                        .connect(regularUser)
                        .setReceivableRequiredInBps(receivableRequiredInBps),
                ).to.be.revertedWithCustomError(poolConfigContract, "permissionDeniedNotAdmin");
            });
        });

        describe("setAdvanceRateInBps", function () {
            let advanceRateInBps = 9_000;

            it("Should allow the pool owner to set the advance rate", async function () {
                await expect(
                    poolConfigContract.connect(poolOwner).setAdvanceRateInBps(advanceRateInBps),
                )
                    .to.emit(poolConfigContract, "AdvanceRateInBpsChanged")
                    .withArgs(advanceRateInBps, poolOwner.address);
                const poolSettings = await poolConfigContract.getPoolSettings();
                expect(poolSettings.advanceRateInBps).to.equal(advanceRateInBps);
            });

            it("Should allow the Huma master admin to set the advance rate", async function () {
                await expect(
                    poolConfigContract
                        .connect(protocolOwner)
                        .setAdvanceRateInBps(advanceRateInBps),
                )
                    .to.emit(poolConfigContract, "AdvanceRateInBpsChanged")
                    .withArgs(advanceRateInBps, protocolOwner.address);
                const poolSettings = await poolConfigContract.getPoolSettings();
                expect(poolSettings.advanceRateInBps).to.equal(advanceRateInBps);
            });

            it("Should reject non-owner or admin to set the advance rate", async function () {
                await expect(
                    poolConfigContract.connect(regularUser).setAdvanceRateInBps(advanceRateInBps),
                ).to.be.revertedWithCustomError(poolConfigContract, "permissionDeniedNotAdmin");
            });

            it("Should reject advance rates higher than 10000", async function () {
                await expect(
                    poolConfigContract.connect(poolOwner).setAdvanceRateInBps(10_001),
                ).to.be.revertedWithCustomError(
                    poolConfigContract,
                    "invalidBasisPointHigherThan10000",
                );
            });
        });

        describe("setWithdrawalLockoutPeriod", function () {
            let calendarUnit: number, lockoutPeriod: number;

            before(function () {
                calendarUnit = CONSTANTS.CALENDAR_UNIT_DAY;
                lockoutPeriod = 30;
            });

            it("Should allow the pool owner to set the withdrawal lockout period", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setWithdrawalLockoutPeriod(calendarUnit, lockoutPeriod),
                )
                    .to.emit(poolConfigContract, "WithdrawalLockoutPeriodChanged")
                    .withArgs(calendarUnit, lockoutPeriod, poolOwner.address);
                const lpConfig = await poolConfigContract.getLPConfig();
                expect(lpConfig.withdrawalLockoutInCalendarUnit).to.equal(lockoutPeriod);
            });

            it("Should allow the Huma master admin to set the withdrawal lockout period", async function () {
                await expect(
                    poolConfigContract
                        .connect(protocolOwner)
                        .setWithdrawalLockoutPeriod(calendarUnit, lockoutPeriod),
                )
                    .to.emit(poolConfigContract, "WithdrawalLockoutPeriodChanged")
                    .withArgs(calendarUnit, lockoutPeriod, protocolOwner.address);
                const lpConfig = await poolConfigContract.getLPConfig();
                expect(lpConfig.withdrawalLockoutInCalendarUnit).to.equal(lockoutPeriod);
            });

            it("Should reject non-owner or admin to set the withdrawal lockout period", async function () {
                await expect(
                    poolConfigContract
                        .connect(regularUser)
                        .setWithdrawalLockoutPeriod(calendarUnit, lockoutPeriod),
                ).to.be.revertedWithCustomError(poolConfigContract, "permissionDeniedNotAdmin");
            });

            it("Should disallow incompatible calendar units", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setWithdrawalLockoutPeriod(CONSTANTS.CALENDAR_UNIT_MONTH, lockoutPeriod),
                ).to.be.revertedWithCustomError(poolConfigContract, "invalidCalendarUnit");
            });
        });

        describe("setLPConfig", function () {
            let newLPConfig: LPConfigStruct;

            before(async function () {
                newLPConfig = {
                    permissioned: false,
                    liquidityCap: toToken(100_000_000),
                    withdrawalLockoutInCalendarUnit: 30,
                    maxSeniorJuniorRatio: 4,
                    fixedSeniorYieldInBps: 2000,
                    tranchesRiskAdjustmentInBps: 8000,
                };
            });

            it("Should allow the pool owner to set the LP config", async function () {
                await expect(poolConfigContract.connect(poolOwner).setLPConfig(newLPConfig))
                    .to.emit(poolConfigContract, "LPConfigChanged")
                    .withArgs(
                        newLPConfig.permissioned,
                        newLPConfig.liquidityCap,
                        newLPConfig.withdrawalLockoutInCalendarUnit,
                        newLPConfig.maxSeniorJuniorRatio,
                        newLPConfig.fixedSeniorYieldInBps,
                        newLPConfig.tranchesRiskAdjustmentInBps,
                        poolOwner.address,
                    );
                const lpConfig = await poolConfigContract.getLPConfig();
                expect(lpConfig.permissioned).to.equal(newLPConfig.permissioned);
                expect(lpConfig.liquidityCap).to.equal(newLPConfig.liquidityCap);
                expect(lpConfig.withdrawalLockoutInCalendarUnit).to.equal(
                    newLPConfig.withdrawalLockoutInCalendarUnit,
                );
                expect(lpConfig.maxSeniorJuniorRatio).to.equal(newLPConfig.maxSeniorJuniorRatio);
                expect(lpConfig.fixedSeniorYieldInBps).to.equal(newLPConfig.fixedSeniorYieldInBps);
                expect(lpConfig.tranchesRiskAdjustmentInBps).to.equal(
                    newLPConfig.tranchesRiskAdjustmentInBps,
                );
            });

            it("Should allow the Huma master admin to set the LP config", async function () {
                await expect(poolConfigContract.connect(protocolOwner).setLPConfig(newLPConfig))
                    .to.emit(poolConfigContract, "LPConfigChanged")
                    .withArgs(
                        newLPConfig.permissioned,
                        newLPConfig.liquidityCap,
                        newLPConfig.withdrawalLockoutInCalendarUnit,
                        newLPConfig.maxSeniorJuniorRatio,
                        newLPConfig.fixedSeniorYieldInBps,
                        newLPConfig.tranchesRiskAdjustmentInBps,
                        protocolOwner.address,
                    );
                const lpConfig = await poolConfigContract.getLPConfig();
                expect(lpConfig.permissioned).to.equal(newLPConfig.permissioned);
                expect(lpConfig.liquidityCap).to.equal(newLPConfig.liquidityCap);
                expect(lpConfig.withdrawalLockoutInCalendarUnit).to.equal(
                    newLPConfig.withdrawalLockoutInCalendarUnit,
                );
                expect(lpConfig.maxSeniorJuniorRatio).to.equal(newLPConfig.maxSeniorJuniorRatio);
                expect(lpConfig.fixedSeniorYieldInBps).to.equal(newLPConfig.fixedSeniorYieldInBps);
                expect(lpConfig.tranchesRiskAdjustmentInBps).to.equal(
                    newLPConfig.tranchesRiskAdjustmentInBps,
                );
            });

            it("Should reject non-owner or admin to set the LP config", async function () {
                await expect(
                    poolConfigContract.connect(regularUser).setLPConfig(newLPConfig),
                ).to.be.revertedWithCustomError(poolConfigContract, "permissionDeniedNotAdmin");
            });
        });

        describe("setFrontLoadingFees", function () {
            let newFrontLoadingFeeStructure: FrontLoadingFeesStructureStruct;

            before(async function () {
                newFrontLoadingFeeStructure = {
                    frontLoadingFeeFlat: toToken(50),
                    frontLoadingFeeBps: BN.from(100),
                };
            });

            it("Should allow the pool owner to set the front loading fees", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setFrontLoadingFees(newFrontLoadingFeeStructure),
                )
                    .to.emit(poolConfigContract, "FrontLoadingFeesChanged")
                    .withArgs(
                        newFrontLoadingFeeStructure.frontLoadingFeeFlat,
                        newFrontLoadingFeeStructure.frontLoadingFeeBps,
                        poolOwner.address,
                    );
                const frontLoadingFees = await poolConfigContract.getFrontLoadingFees();
                expect(frontLoadingFees[0]).to.equal(
                    newFrontLoadingFeeStructure.frontLoadingFeeFlat,
                );
                expect(frontLoadingFees[1]).to.equal(
                    newFrontLoadingFeeStructure.frontLoadingFeeBps,
                );
            });

            it("Should allow the Huma master admin to set the front loading fees", async function () {
                await expect(
                    poolConfigContract
                        .connect(protocolOwner)
                        .setFrontLoadingFees(newFrontLoadingFeeStructure),
                )
                    .to.emit(poolConfigContract, "FrontLoadingFeesChanged")
                    .withArgs(
                        newFrontLoadingFeeStructure.frontLoadingFeeFlat,
                        newFrontLoadingFeeStructure.frontLoadingFeeBps,
                        protocolOwner.address,
                    );
                const frontLoadingFees = await poolConfigContract.getFrontLoadingFees();
                expect(frontLoadingFees[0]).to.equal(
                    newFrontLoadingFeeStructure.frontLoadingFeeFlat,
                );
                expect(frontLoadingFees[1]).to.equal(
                    newFrontLoadingFeeStructure.frontLoadingFeeBps,
                );
            });

            it("Should reject non-owner or admin to set the front loading fees", async function () {
                await expect(
                    poolConfigContract
                        .connect(regularUser)
                        .setFrontLoadingFees(newFrontLoadingFeeStructure),
                ).to.be.revertedWithCustomError(poolConfigContract, "permissionDeniedNotAdmin");
            });
        });

        describe("setFeeStructure", function () {
            let newFeeStructure: FeeStructureStruct;

            before(async function () {
                newFeeStructure = {
                    yieldInBps: BN.from(1000),
                    minPrincipalRateInBps: BN.from(2000),
                    lateFeeFlat: toToken(1_000),
                    lateFeeBps: BN.from(3000),
                    membershipFee: toToken(50),
                };
            });

            it("Should allow the pool owner to set the fee structure", async function () {
                await expect(
                    poolConfigContract.connect(poolOwner).setFeeStructure(newFeeStructure),
                )
                    .to.emit(poolConfigContract, "FeeStructureChanged")
                    .withArgs(
                        newFeeStructure.yieldInBps,
                        newFeeStructure.minPrincipalRateInBps,
                        newFeeStructure.lateFeeFlat,
                        newFeeStructure.lateFeeBps,
                        newFeeStructure.membershipFee,
                        poolOwner.address,
                    );
                const poolSummary = await poolConfigContract.getPoolSummary();
                const fees = await poolConfigContract.getFees();
                const minPrincipalRateInBps = await poolConfigContract.getMinPrincipalRateInBps();
                expect(poolSummary[1]).to.equal(newFeeStructure.yieldInBps);
                expect(fees[0]).to.equal(newFeeStructure.lateFeeFlat);
                expect(fees[1]).to.equal(newFeeStructure.lateFeeBps);
                expect(fees[2]).to.equal(newFeeStructure.membershipFee);
                expect(minPrincipalRateInBps).to.equal(newFeeStructure.minPrincipalRateInBps);
            });

            it("Should allow the Huma master admin to set the fee structure", async function () {
                await expect(
                    poolConfigContract.connect(protocolOwner).setFeeStructure(newFeeStructure),
                )
                    .to.emit(poolConfigContract, "FeeStructureChanged")
                    .withArgs(
                        newFeeStructure.yieldInBps,
                        newFeeStructure.minPrincipalRateInBps,
                        newFeeStructure.lateFeeFlat,
                        newFeeStructure.lateFeeBps,
                        newFeeStructure.membershipFee,
                        protocolOwner.address,
                    );
                const poolSummary = await poolConfigContract.getPoolSummary();
                const fees = await poolConfigContract.getFees();
                const minPrincipalRateInBps = await poolConfigContract.getMinPrincipalRateInBps();
                expect(poolSummary[1]).to.equal(newFeeStructure.yieldInBps);
                expect(fees[0]).to.equal(newFeeStructure.lateFeeFlat);
                expect(fees[1]).to.equal(newFeeStructure.lateFeeBps);
                expect(fees[2]).to.equal(newFeeStructure.membershipFee);
                expect(minPrincipalRateInBps).to.equal(newFeeStructure.minPrincipalRateInBps);
            });

            it("Should reject non-owner or admin to set the fee structure", async function () {
                await expect(
                    poolConfigContract.connect(regularUser).setFeeStructure(newFeeStructure),
                ).to.be.revertedWithCustomError(poolConfigContract, "permissionDeniedNotAdmin");
            });
        });

        // TODO(jiatu): add tests for first loss cover checks

        describe("checkLiquidityRequirementForPoolOwner", function () {
            let minRequirement: BN;

            before(async function () {
                minRequirement = await getMinLiquidityRequirementForPoolOwner(poolConfigContract);
            });

            it("Should pass the checks when there is enough liquidity", async function () {
                await poolConfigContract.checkLiquidityRequirementForPoolOwner(minRequirement);
            });

            it("Should revert when the pool owner has not provided enough liquidity", async function () {
                await expect(
                    poolConfigContract.checkLiquidityRequirementForPoolOwner(
                        minRequirement.sub(1),
                    ),
                ).to.be.revertedWithCustomError(poolConfigContract, "poolOwnerNotEnoughLiquidity");
            });
        });

        describe("checkLiquidityRequirementForEA", function () {
            let minRequirement: BN;

            before(async function () {
                minRequirement = await getMinLiquidityRequirementForEA(poolConfigContract);
            });

            it("Should pass the checks when there is enough liquidity", async function () {
                await poolConfigContract.checkLiquidityRequirementForEA(minRequirement);
            });

            it("Should revert when the pool owner has not provided enough liquidity", async function () {
                await expect(
                    poolConfigContract.checkLiquidityRequirementForEA(minRequirement.sub(1)),
                ).to.be.revertedWithCustomError(
                    poolConfigContract,
                    "evaluationAgentNotEnoughLiquidity",
                );
            });
        });

        describe("checkLiquidityRequirementForRedemption", function () {
            let poolOwnerMinRequirement: BN, eaMinRequirement: BN;

            before(async function () {
                poolOwnerMinRequirement =
                    await getMinLiquidityRequirementForPoolOwner(poolConfigContract);
                eaMinRequirement = await getMinLiquidityRequirementForEA(poolConfigContract);
            });

            it("Should pass the check for non-admins even if they have not deposited liquidity", async function () {
                await poolConfigContract.checkLiquidityRequirementForRedemption(
                    regularUser.address,
                    juniorTrancheVaultContract.address,
                    0,
                );
            });

            it("Should pass the check when the pool owner still has enough liquidity after redemption in the junior tranche", async function () {
                await poolConfigContract.checkLiquidityRequirementForRedemption(
                    poolOwner.address,
                    juniorTrancheVaultContract.address,
                    poolOwnerMinRequirement,
                );
            });

            it("Should pass the check when the evaluation agent still has enough liquidity after redemption in the junior tranche", async function () {
                await poolConfigContract.checkLiquidityRequirementForRedemption(
                    evaluationAgent.address,
                    juniorTrancheVaultContract.address,
                    eaMinRequirement,
                );
            });

            it("Should pass the check even if the pool owner does not have any liquidity left in the senior tranche", async function () {
                await poolConfigContract.checkLiquidityRequirementForRedemption(
                    poolOwner.address,
                    seniorTrancheVaultContract.address,
                    0,
                );
            });

            it("Should pass the check even if the EA does not have any liquidity left in the senior tranche", async function () {
                await poolConfigContract.checkLiquidityRequirementForRedemption(
                    evaluationAgent.address,
                    seniorTrancheVaultContract.address,
                    0,
                );
            });

            it("Should revert when the pool owner no longer has enough liquidity after redemption in the junior tranche", async function () {
                await expect(
                    poolConfigContract.checkLiquidityRequirementForRedemption(
                        poolOwnerTreasury.address,
                        juniorTrancheVaultContract.address,
                        poolOwnerMinRequirement.sub(1),
                    ),
                ).to.be.revertedWithCustomError(poolConfigContract, "poolOwnerNotEnoughLiquidity");
            });

            it("Should revert when EA no longer has enough liquidity after redemption in the junior tranche", async function () {
                await expect(
                    poolConfigContract.checkLiquidityRequirementForRedemption(
                        evaluationAgent.address,
                        juniorTrancheVaultContract.address,
                        eaMinRequirement.sub(1),
                    ),
                ).to.be.revertedWithCustomError(
                    poolConfigContract,
                    "evaluationAgentNotEnoughLiquidity",
                );
            });
        });
    });
});
