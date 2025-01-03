// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.23;

import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ICalendar} from "./interfaces/ICalendar.sol";
import {IPoolFeeManager} from "../liquidity/interfaces/IPoolFeeManager.sol";
import {IPool} from "../liquidity/interfaces/IPool.sol";
import {IFirstLossCover} from "../liquidity/interfaces/IFirstLossCover.sol";
import {ITranchesPolicy} from "../liquidity/interfaces/ITranchesPolicy.sol";
import {ADMIN_LOSS_COVER_INDEX, HUNDRED_PERCENT_IN_BPS, PayPeriodDuration} from "./SharedDefs.sol";
import {HumaConfig} from "./HumaConfig.sol";
import {Errors} from "./Errors.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

struct PoolSettings {
    // The maximum credit line for a borrower in terms of the amount of poolTokens
    uint96 maxCreditLine;
    // The minimum amount a lender/First Loss Cover provider needs to supply each time they deposit.
    // This is also the absolute minimum balance the pool owner needs to maintain in tranches to prevent
    // inflation attacks.
    uint96 minDepositAmount;
    // The number of months in one pay period
    PayPeriodDuration payPeriodDuration;
    // The grace period before a late fee can be charged, in the unit of number of days
    uint8 latePaymentGracePeriodInDays;
    // The grace period before a default can be triggered, in days. This can be 0.
    uint16 defaultGracePeriodInDays;
    // Specifies the max credit line as a percentage (in basis points) of the receivable amount.
    // E.g., for a receivable of $100 with an advance rate of 9000 bps, the credit line can be up to $90.
    uint16 advanceRateInBps;
    // Specifies whether receivables should be automatically approved during initial drawdown. If `false`, then
    // receivables need to be approved prior to the first drawdown.
    bool receivableAutoApproval;
    // Specifies whether the `makePrincipalPayment()` functionality is allowed.
    bool principalOnlyPaymentAllowed;
}

/**
 * @notice Rewards and Responsibilities for various admins.
 */
struct AdminRnR {
    // Percentage of pool income allocated to EA
    uint16 rewardRateInBpsForEA;
    // Percentage of pool income allocated to Pool Owner
    uint16 rewardRateInBpsForPoolOwner;
    // Percentage of the liquidityCap to be contributed by EA in the junior tranche.
    uint16 liquidityRateInBpsByEA;
    // Percentage of the liquidityCap to be contributed by Pool Owner in the junior tranche.
    uint16 liquidityRateInBpsByPoolOwner;
}

struct LPConfig {
    // The max liquidity allowed for the pool.
    uint96 liquidityCap;
    // The upper bound of senior-to-junior ratio allowed
    uint8 maxSeniorJuniorRatio;
    // The fixed yield for senior tranche. Either this or tranchesRiskAdjustmentInBps is non-zero
    uint16 fixedSeniorYieldInBps;
    // Percentage of yield to be shifted from senior to junior. Either this or fixedSeniorYieldInBps is non-zero
    uint16 tranchesRiskAdjustmentInBps;
    // How long a lender has to wait after the last deposit before they can withdraw
    uint16 withdrawalLockoutPeriodInDays;
    // When enabled, lenders' shares are automatically redeemed after the lockup period.
    bool autoRedemptionAfterLockup;
}

struct FrontLoadingFeesStructure {
    // Part of platform fee, charged as a flat amount when borrowing occurs.
    uint96 frontLoadingFeeFlat;
    // Part of platform fee, charged as a % of the borrowing amount when borrowing occurs.
    uint16 frontLoadingFeeBps;
}

struct FeeStructure {
    // Expected yield in basis points.
    uint16 yieldInBps;
    // The min % of the outstanding principal to be paid in the statement for each period.
    uint16 minPrincipalRateInBps;
    // The late fee rate expressed in bps. The late fee is the additional charge on top of the yield
    // when a payment is late, and is calculated as a % of the total outstanding balance.
    uint16 lateFeeBps;
}

struct FirstLossCoverConfig {
    // The percentage of loss to be paid by the first loss cover per occurrence of loss
    uint16 coverRatePerLossInBps;
    // The max amount that first loss cover can spend on one occurrence of loss
    uint96 coverCapPerLoss;
    // The max liquidity allowed for the first loss cover
    uint96 maxLiquidity;
    // The min liquidity required for the first loss cover
    uint96 minLiquidity;
    // Adjusts the yield of the first loss covers and junior tranche
    uint16 riskYieldMultiplierInBps;
}

interface ITrancheVaultLike {
    function totalAssetsOf(address account) external view returns (uint256 assets);
}

contract PoolConfig is Initializable, AccessControlUpgradeable, UUPSUpgradeable {
    bytes32 public constant POOL_OPERATOR_ROLE = keccak256("POOL_OPERATOR");
    /// The smallest value that `PoolSettings.minDepositAmount` can be set to. Note that this value is "pre-decimals",
    /// i.e. if the underlying token is USDC, then this represents $10 in USDC.
    uint256 private constant _MIN_DEPOSIT_AMOUNT_THRESHOLD = 10;

    string public poolName;

    address public pool;
    address public poolSafe;
    address public seniorTranche;
    address public juniorTranche;
    address public tranchesPolicy;
    address public epochManager;
    address public poolFeeManager;
    address public calendar;

    address public creditDueManager;
    address public credit;
    address public creditManager;

    HumaConfig public humaConfig;

    /// The ERC20 token this pool manages.
    address public underlyingToken;

    /// Evaluation Agents (EA) are the risk underwriting agents that associated with the pool.
    address public evaluationAgent;

    /// The maximum number of first loss covers we allow is 16, which should be sufficient for now.
    address[16] internal _firstLossCovers;
    mapping(address => FirstLossCoverConfig) internal _firstLossCoverConfigs;

    PoolSettings internal _poolSettings;
    LPConfig internal _lpConfig;
    AdminRnR internal _adminRnR;
    FrontLoadingFeesStructure internal _frontFees;
    FeeStructure internal _feeStructure;

    /// Address for the account that handles the treasury functions for the pool owner:
    /// liquidity deposits, liquidity withdrawals, and reward withdrawals.
    address public poolOwnerTreasury;

    address public receivableAsset;

    event EARewardsAndLiquidityChanged(uint256 rewardRate, uint256 liquidityRate, address by);
    event EvaluationAgentChanged(address oldEA, address newEA, address by);
    event EvaluationAgentFeesWithdrawalFailed(address oldEA, uint256 fees, string reason);
    event PoolFeeManagerChanged(address poolFeeManager, address by);
    event HumaConfigChanged(address humaConfig, address by);

    event PoolChanged(address pool, address by);
    event PoolNameChanged(string name, address by);
    event PoolOwnerRewardsAndLiquidityChanged(
        uint256 rewardRate,
        uint256 liquidityRate,
        address by
    );
    event PoolOwnerTreasuryChanged(address treasury, address by);
    event PoolUnderlyingTokenChanged(address underlyingToken, address by);
    event TranchesChanged(address seniorTranche, address juniorTranche, address by);
    event PoolSafeChanged(address poolSafe, address by);
    event TranchesPolicyChanged(address tranchesPolicy, address by);
    event EpochManagerChanged(address epochManager, address by);
    event CreditDueManagerChanged(address creditDueManager, address by);
    event CreditChanged(address credit, address by);
    event CreditManagerChanged(address creditManager, address by);
    event FirstLossCoverChanged(
        uint8 index,
        address firstLossCover,
        uint16 coverRatePerLossInBps,
        uint96 coverCapPerLoss,
        uint96 maxLiquidity,
        uint96 minLiquidity,
        uint16 riskYieldMultiplierInBps,
        address by
    );
    event CalendarChanged(address calendar, address by);
    event ReceivableAssetChanged(address receivableAsset, address by);

    event PoolSettingsChanged(
        uint96 maxCreditLine,
        uint96 minDepositAmount,
        PayPeriodDuration payPeriodDuration,
        uint8 latePaymentGracePeriodInDays,
        uint16 defaultGracePeriodInDays,
        uint16 advanceRateInBps,
        bool receivableAutoApproval,
        bool principalOnlyPaymentAllowed,
        address by
    );

    event LPConfigChanged(
        uint96 liquidityCap,
        uint8 maxSeniorJuniorRatio,
        uint16 fixedSeniorYieldInBps,
        uint16 tranchesRiskAdjustmentInBps,
        uint16 withdrawalLockoutInDays,
        bool autoRedemptionAfterLockup,
        address by
    );
    event FrontLoadingFeesChanged(
        uint96 frontLoadingFeeFlat,
        uint16 frontLoadingFeeBps,
        address by
    );
    event FeeStructureChanged(
        uint16 yieldInBps,
        uint16 minPrincipalRateInBps,
        uint16 lateFeeBps,
        address by
    );

    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the pool configuration.
     * @param poolName_ The name of the pool.
     * @param contracts The addresses of the contracts that are used by the pool.
     *   contracts[0]: address of HumaConfig
     *   contracts[1]: address of underlyingToken
     *   contracts[2]: address of calendar
     *   contracts[3]: address of pool
     *   contracts[4]: address of poolSafe
     *   contracts[5]: address of poolFeeManager
     *   contracts[6]: address of tranchesPolicy
     *   contracts[7]: address of epochManager
     *   contracts[8]: address of seniorTranche
     *   contracts[9]: address of juniorTranche
     *   contracts[10]: address of credit
     *   contracts[11]: address of creditDueManager
     *   contracts[12]: address of creditManager
     */
    function initialize(string memory poolName_, address[] memory contracts) external initializer {
        poolName = poolName_;

        for (uint256 i = 0; i < contracts.length; i++) {
            if (contracts[i] == address(0)) revert Errors.ZeroAddressProvided();
        }

        humaConfig = HumaConfig(contracts[0]);
        address addr = contracts[1];
        if (!humaConfig.isAssetValid(addr))
            revert Errors.UnderlyingTokenNotApprovedForHumaProtocol();
        underlyingToken = addr;
        calendar = contracts[2];
        pool = contracts[3];
        poolSafe = contracts[4];
        poolFeeManager = contracts[5];
        tranchesPolicy = contracts[6];
        epochManager = contracts[7];
        seniorTranche = contracts[8];
        juniorTranche = contracts[9];
        credit = contracts[10];
        creditDueManager = contracts[11];
        creditManager = contracts[12];

        // Default values for the pool configurations. The pool owners are expected to reset
        // these values when setting up the pools. Setting these default values to avoid
        // strange behaviors when the pool owner missed setting up these configurations.
        PoolSettings memory tempPoolSettings = _poolSettings;
        tempPoolSettings.minDepositAmount = uint96(
            _MIN_DEPOSIT_AMOUNT_THRESHOLD * 10 ** IERC20Metadata(underlyingToken).decimals()
        );
        tempPoolSettings.payPeriodDuration = PayPeriodDuration.Monthly;
        tempPoolSettings.advanceRateInBps = 8000; // 80%
        tempPoolSettings.latePaymentGracePeriodInDays = 5;
        _poolSettings = tempPoolSettings;

        AdminRnR memory adminRnRConfig = _adminRnR;
        adminRnRConfig.rewardRateInBpsForEA = 300; // 3%
        adminRnRConfig.rewardRateInBpsForPoolOwner = 200; // 2%
        adminRnRConfig.liquidityRateInBpsByEA = 200; // 2%
        adminRnRConfig.liquidityRateInBpsByPoolOwner = 200; // 2%
        _adminRnR = adminRnRConfig;

        LPConfig memory lpConfig = _lpConfig;
        lpConfig.maxSeniorJuniorRatio = 4; // senior : junior = 4:1
        lpConfig.withdrawalLockoutPeriodInDays = 90;
        _lpConfig = lpConfig;

        __AccessControl_init();
        __UUPSUpgradeable_init();
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    /// @custom:access Only the pool owner and the Huma owner can call this function.
    function setPoolOwnerRewardsAndLiquidity(uint256 rewardRate, uint256 liquidityRate) external {
        _onlyPoolOwnerOrHumaOwner();
        if (rewardRate > HUNDRED_PERCENT_IN_BPS || liquidityRate > HUNDRED_PERCENT_IN_BPS)
            revert Errors.InvalidBasisPointHigherThan10000();
        AdminRnR memory tempAdminRnR = _adminRnR;
        if (rewardRate + tempAdminRnR.rewardRateInBpsForEA > HUNDRED_PERCENT_IN_BPS) {
            // Since we split the profit between the pool owner and EA, their combined reward rate cannot exceed 100%.
            revert Errors.AdminRewardRateTooHigh();
        }

        tempAdminRnR.rewardRateInBpsForPoolOwner = uint16(rewardRate);
        tempAdminRnR.liquidityRateInBpsByPoolOwner = uint16(liquidityRate);
        _adminRnR = tempAdminRnR;
        emit PoolOwnerRewardsAndLiquidityChanged(rewardRate, liquidityRate, msg.sender);
    }

    /// @custom:access Only the pool owner and the Huma owner can call this function.
    function setEARewardsAndLiquidity(uint256 rewardRate, uint256 liquidityRate) external {
        _onlyPoolOwnerOrHumaOwner();
        if (rewardRate > HUNDRED_PERCENT_IN_BPS || liquidityRate > HUNDRED_PERCENT_IN_BPS)
            revert Errors.InvalidBasisPointHigherThan10000();
        AdminRnR memory tempAdminRnR = _adminRnR;
        if (rewardRate + tempAdminRnR.rewardRateInBpsForPoolOwner > HUNDRED_PERCENT_IN_BPS) {
            // Since we split the profit between the pool owner and EA, their combined reward rate cannot exceed 100%.
            revert Errors.AdminRewardRateTooHigh();
        }

        tempAdminRnR.rewardRateInBpsForEA = uint16(rewardRate);
        tempAdminRnR.liquidityRateInBpsByEA = uint16(liquidityRate);
        _adminRnR = tempAdminRnR;
        emit EARewardsAndLiquidityChanged(rewardRate, liquidityRate, msg.sender);
    }

    /**
     * @notice Adds an Evaluation Agent to the list who can approve loans.
     * @param agent The Evaluation Agent to be added.
     * @custom:access Only the pool owner and the Huma owner can call this function.
     */
    function setEvaluationAgent(address agent) external {
        if (agent == address(0)) revert Errors.ZeroAddressProvided();
        _onlyPoolOwnerOrHumaOwner();

        // Transfer the accrued EA income to the old EA's wallet.
        // Decided not to check if there is enough balance in the pool. If there is
        // not enough balance, the transaction will fail. PoolOwner has to find enough
        // liquidity to pay the EA before replacing it.
        address oldEA = evaluationAgent;
        if (oldEA != address(0)) {
            IPoolFeeManager feeManager = IPoolFeeManager(poolFeeManager);
            (, , uint256 eaFees) = feeManager.getWithdrawables();
            // The underlying asset of the pool may incorporate a blocklist feature that prevents the old EA
            // from receiving funds if they are subject to sanctions. Under these circumstances,
            // it is acceptable to bypass the funds of the old EA and proceed with enforcing the replacement.
            if (eaFees > 0) {
                try feeManager.withdrawEAFee(eaFees) {} catch Error(string memory reason) {
                    emit EvaluationAgentFeesWithdrawalFailed(oldEA, eaFees, reason);
                }
            }
        }

        // Make sure the new EA meets the liquidity requirements.
        if (IPool(pool).isPoolOn()) {
            if (!IFirstLossCover(_firstLossCovers[ADMIN_LOSS_COVER_INDEX]).isSufficient()) {
                revert Errors.InsufficientFirstLossCover();
            }
            ITrancheVaultLike juniorTrancheVault = ITrancheVaultLike(juniorTranche);
            _checkLiquidityRequirementForEA(juniorTrancheVault.totalAssetsOf(agent));
        }

        evaluationAgent = agent;

        emit EvaluationAgentChanged(oldEA, agent, msg.sender);
    }

    /// @custom:access Only the pool owner and the Huma owner can call this function.
    function setPoolFeeManager(address poolFeeManager_) external {
        _onlyPoolOwnerOrHumaOwner();
        if (poolFeeManager_ == address(0)) revert Errors.ZeroAddressProvided();
        poolFeeManager = poolFeeManager_;
        emit PoolFeeManagerChanged(poolFeeManager_, msg.sender);
    }

    /// @custom:access Only the Huma owner can call this function.
    function setHumaConfig(address humaConfig_) external {
        onlyHumaOwner(msg.sender);
        if (humaConfig_ == address(0)) revert Errors.ZeroAddressProvided();
        humaConfig = HumaConfig(humaConfig_);
        emit HumaConfigChanged(humaConfig_, msg.sender);
    }

    /// @custom:access Only the pool owner and the Huma owner can call this function.
    function setPool(address pool_) external {
        _onlyPoolOwnerOrHumaOwner();
        if (pool_ == address(0)) revert Errors.ZeroAddressProvided();
        pool = pool_;
        emit PoolChanged(pool_, msg.sender);
    }

    /// @custom:access Only the pool owner and the Huma owner can call this function.
    function setPoolName(string memory newName) external {
        _onlyPoolOwnerOrHumaOwner();
        poolName = newName;
        emit PoolNameChanged(newName, msg.sender);
    }

    /// @custom:access Only the pool owner and the Huma owner can call this function.
    function setPoolOwnerTreasury(address poolOwnerTreasury_) external {
        _onlyPoolOwnerOrHumaOwner();
        if (poolOwnerTreasury_ == address(0)) revert Errors.ZeroAddressProvided();
        poolOwnerTreasury = poolOwnerTreasury_;
        emit PoolOwnerTreasuryChanged(poolOwnerTreasury_, msg.sender);
    }

    /// @custom:access Only the pool owner and the Huma owner can call this function.
    function setTranches(address seniorTranche_, address juniorTranche_) external {
        _onlyPoolOwnerOrHumaOwner();
        if (seniorTranche_ == address(0) || juniorTranche_ == address(0))
            revert Errors.ZeroAddressProvided();
        seniorTranche = seniorTranche_;
        juniorTranche = juniorTranche_;
        emit TranchesChanged(seniorTranche_, juniorTranche_, msg.sender);
    }

    /// @custom:access Only the pool owner and the Huma owner can call this function.
    function setPoolSafe(address poolSafe_) external {
        _onlyPoolOwnerOrHumaOwner();
        if (poolSafe_ == address(0)) revert Errors.ZeroAddressProvided();
        poolSafe = poolSafe_;
        emit PoolSafeChanged(poolSafe, msg.sender);
    }

    /// @custom:access Only the pool owner and the Huma owner can call this function.
    function setTranchesPolicy(address tranchesPolicy_) external {
        _onlyPoolOwnerOrHumaOwner();
        if (tranchesPolicy_ == address(0)) revert Errors.ZeroAddressProvided();
        tranchesPolicy = tranchesPolicy_;
        emit TranchesPolicyChanged(tranchesPolicy_, msg.sender);
    }

    /// @custom:access Only the pool owner and the Huma owner can call this function.
    function setEpochManager(address epochManager_) external {
        _onlyPoolOwnerOrHumaOwner();
        if (epochManager_ == address(0)) revert Errors.ZeroAddressProvided();
        epochManager = epochManager_;
        emit EpochManagerChanged(epochManager, msg.sender);
    }

    /// @custom:access Only the pool owner and the Huma owner can call this function.
    function setCreditDueManager(address creditDueManager_) external {
        _onlyPoolOwnerOrHumaOwner();
        if (creditDueManager_ == address(0)) revert Errors.ZeroAddressProvided();
        creditDueManager = creditDueManager_;
        emit CreditDueManagerChanged(creditDueManager_, msg.sender);
    }

    /// @custom:access Only the pool owner and the Huma owner can call this function.
    function setCredit(address credit_) external {
        _onlyPoolOwnerOrHumaOwner();
        if (credit_ == address(0)) revert Errors.ZeroAddressProvided();
        credit = credit_;
        emit CreditChanged(credit_, msg.sender);
    }

    /// @custom:access Only the pool owner and the Huma owner can call this function.
    function setCreditManager(address creditManager_) external {
        _onlyPoolOwnerOrHumaOwner();
        if (creditManager_ == address(0)) revert Errors.ZeroAddressProvided();
        creditManager = creditManager_;
        emit CreditManagerChanged(creditManager_, msg.sender);
    }

    /// @custom:access Only the pool owner and the Huma owner can call this function.
    function setFirstLossCover(
        uint8 index,
        address firstLossCover,
        FirstLossCoverConfig memory config
    ) external {
        _onlyPoolOwnerOrHumaOwner();
        if (config.coverRatePerLossInBps > HUNDRED_PERCENT_IN_BPS)
            revert Errors.InvalidBasisPointHigherThan10000();

        _firstLossCovers[index] = firstLossCover;
        _firstLossCoverConfigs[firstLossCover] = config;

        emit FirstLossCoverChanged(
            index,
            firstLossCover,
            config.coverRatePerLossInBps,
            config.coverCapPerLoss,
            config.maxLiquidity,
            config.minLiquidity,
            config.riskYieldMultiplierInBps,
            msg.sender
        );
    }

    /// @custom:access Only the pool owner and the Huma owner can call this function.
    function setCalendar(address calendar_) external {
        _onlyPoolOwnerOrHumaOwner();
        if (calendar_ == address(0)) revert Errors.ZeroAddressProvided();
        calendar = calendar_;
        emit CalendarChanged(calendar_, msg.sender);
    }

    /// @custom:access Only the pool owner and the Huma owner can call this function.
    function setReceivableAsset(address receivableAsset_) external {
        _onlyPoolOwnerOrHumaOwner();
        if (receivableAsset_ == address(0)) revert Errors.ZeroAddressProvided();
        receivableAsset = receivableAsset_;
        emit ReceivableAssetChanged(receivableAsset_, msg.sender);
    }

    /// @custom:access Only the pool owner and the Huma owner can call this function.
    function setPoolSettings(PoolSettings memory settings) external {
        _onlyPoolOwnerOrHumaOwner();
        if (
            settings.minDepositAmount <
            uint96(
                _MIN_DEPOSIT_AMOUNT_THRESHOLD * 10 ** IERC20Metadata(underlyingToken).decimals()
            )
        ) {
            revert Errors.MinDepositAmountTooLow();
        }
        if (
            settings.latePaymentGracePeriodInDays >=
            ICalendar(calendar).getTotalDaysInFullPeriod(settings.payPeriodDuration)
        ) {
            revert Errors.LatePaymentGracePeriodTooLong();
        }
        if (settings.advanceRateInBps > HUNDRED_PERCENT_IN_BPS) {
            revert Errors.InvalidBasisPointHigherThan10000();
        }
        _poolSettings = settings;
        emit PoolSettingsChanged(
            settings.maxCreditLine,
            settings.minDepositAmount,
            settings.payPeriodDuration,
            settings.latePaymentGracePeriodInDays,
            settings.defaultGracePeriodInDays,
            settings.advanceRateInBps,
            settings.receivableAutoApproval,
            settings.principalOnlyPaymentAllowed,
            msg.sender
        );
    }

    /// @custom:access Only the pool owner and the Huma owner can call this function.
    function setLPConfig(LPConfig memory lpConfig) external {
        if (msg.sender != address(pool)) _onlyPoolOwnerOrHumaOwner();
        if (
            lpConfig.fixedSeniorYieldInBps > HUNDRED_PERCENT_IN_BPS ||
            lpConfig.tranchesRiskAdjustmentInBps > HUNDRED_PERCENT_IN_BPS
        ) revert Errors.InvalidBasisPointHigherThan10000();
        if (lpConfig.fixedSeniorYieldInBps != _lpConfig.fixedSeniorYieldInBps) {
            ITranchesPolicy(tranchesPolicy).refreshYieldTracker(
                IPool(pool).currentTranchesAssets()
            );
        }

        _lpConfig = lpConfig;
        emit LPConfigChanged(
            lpConfig.liquidityCap,
            lpConfig.maxSeniorJuniorRatio,
            lpConfig.fixedSeniorYieldInBps,
            lpConfig.tranchesRiskAdjustmentInBps,
            lpConfig.withdrawalLockoutPeriodInDays,
            lpConfig.autoRedemptionAfterLockup,
            msg.sender
        );
    }

    /// @custom:access Only the pool owner and the Huma owner can call this function.
    function setFrontLoadingFees(FrontLoadingFeesStructure memory frontFees) external {
        _onlyPoolOwnerOrHumaOwner();
        if (frontFees.frontLoadingFeeBps > HUNDRED_PERCENT_IN_BPS)
            revert Errors.InvalidBasisPointHigherThan10000();

        _frontFees = frontFees;
        emit FrontLoadingFeesChanged(
            frontFees.frontLoadingFeeFlat,
            frontFees.frontLoadingFeeBps,
            msg.sender
        );
    }

    /// @custom:access Only the pool owner and the Huma owner can call this function.
    function setFeeStructure(FeeStructure memory feeStructure) external {
        _onlyPoolOwnerOrHumaOwner();
        if (
            feeStructure.minPrincipalRateInBps > HUNDRED_PERCENT_IN_BPS ||
            feeStructure.lateFeeBps > HUNDRED_PERCENT_IN_BPS
        ) revert Errors.InvalidBasisPointHigherThan10000();

        _feeStructure = feeStructure;
        emit FeeStructureChanged(
            feeStructure.yieldInBps,
            feeStructure.minPrincipalRateInBps,
            feeStructure.lateFeeBps,
            msg.sender
        );
    }

    function getLPConfig() external view returns (LPConfig memory) {
        return _lpConfig;
    }

    function getAdminRnR() external view returns (AdminRnR memory) {
        return _adminRnR;
    }

    function getFirstLossCovers() external view returns (address[16] memory) {
        return _firstLossCovers;
    }

    function getFirstLossCover(uint256 index) external view returns (address) {
        return _firstLossCovers[index];
    }

    function isFirstLossCover(address account) external view returns (bool isCover) {
        uint256 numCovers = _firstLossCovers.length;
        for (uint256 i = 0; i < numCovers; i++) {
            if (account == address(_firstLossCovers[i])) return true;
        }
        return false;
    }

    function getFirstLossCoverConfig(
        address firstLossCover
    ) external view returns (FirstLossCoverConfig memory) {
        return _firstLossCoverConfigs[firstLossCover];
    }

    function getPoolSettings() external view returns (PoolSettings memory) {
        return _poolSettings;
    }

    function getFrontLoadingFees() external view returns (uint256, uint256) {
        return (_frontFees.frontLoadingFeeFlat, _frontFees.frontLoadingFeeBps);
    }

    function getFeeStructure() external view returns (FeeStructure memory) {
        return _feeStructure;
    }

    function onlyPool(address account) external view {
        if (account != pool) revert Errors.AuthorizedContractCallerRequired();
    }

    function onlyProtocolAndPoolOn() external view {
        if (humaConfig.paused()) revert Errors.ProtocolIsPaused();
        if (!IPool(pool).isPoolOn()) revert Errors.PoolIsNotOn();
    }

    function onlyPoolOperator(address account) external view {
        if (!hasRole(POOL_OPERATOR_ROLE, account)) revert Errors.PoolOperatorRequired();
    }

    /**
     * @notice Checks whether the admin first loss cover has met the liquidity requirements.
     */
    function checkFirstLossCoverRequirementsForAdmin() external view {
        IFirstLossCover firstLossCover = IFirstLossCover(_firstLossCovers[ADMIN_LOSS_COVER_INDEX]);
        if (!firstLossCover.isSufficient()) revert Errors.InsufficientFirstLossCover();
    }

    /**
     * @notice Checks whether both the EA and the pool owner treasury have met the pool's liquidity requirements
     */
    function checkLiquidityRequirements() external view {
        ITrancheVaultLike juniorTrancheVault = ITrancheVaultLike(juniorTranche);
        // Pool owner needs to satisfy the liquidity requirements for both the junior and senior tranches.
        _checkLiquidityRequirementForPoolOwner(
            juniorTranche,
            juniorTrancheVault.totalAssetsOf(poolOwnerTreasury)
        );
        _checkLiquidityRequirementForPoolOwner(
            seniorTranche,
            ITrancheVaultLike(seniorTranche).totalAssetsOf(poolOwnerTreasury)
        );

        if (evaluationAgent != address(0)) {
            // EA only needs to satisfy the liquidity requirement in the junior tranche.
            _checkLiquidityRequirementForEA(juniorTrancheVault.totalAssetsOf(evaluationAgent));
        }
    }

    /**
     * @notice Checks whether the lender can still meet the liquidity requirements after redemption.
     * @param lender The lender address.
     * @param trancheVault The tranche vault address.
     * @param newBalance The resulting balance of the lender after redemption.
     */
    function checkLiquidityRequirementForRedemption(
        address lender,
        address trancheVault,
        uint256 newBalance
    ) external view {
        if (lender == poolOwnerTreasury) {
            // The pool owner needs to satisfy the liquidity requirement in both tranches.
            _checkLiquidityRequirementForPoolOwner(trancheVault, newBalance);
        }
        if (lender == evaluationAgent && trancheVault == juniorTranche) {
            // EA is only required to participate in the junior tranche.
            _checkLiquidityRequirementForEA(newBalance);
        }
    }

    function onlyPoolOwner(address account) public view {
        // Treat DEFAULT_ADMIN_ROLE role as owner role
        if (!hasRole(DEFAULT_ADMIN_ROLE, account)) revert Errors.PoolOwnerRequired();
    }

    /**
     * @notice "Modifier" function that limits access to the pool owner or the Sentinel Service account.
     */
    function onlyPoolOwnerOrSentinelServiceAccount(address account) public view {
        // Treat DEFAULT_ADMIN_ROLE role as owner role
        if (
            !hasRole(DEFAULT_ADMIN_ROLE, account) && account != humaConfig.sentinelServiceAccount()
        ) revert Errors.AuthorizedContractCallerRequired();
    }

    /**
     * @notice "Modifier" function that limits access to pool owner or EA.
     */
    function onlyPoolOwnerOrEA(address account) public view returns (address) {
        if (
            !hasRole(DEFAULT_ADMIN_ROLE, account) &&
            account != evaluationAgent &&
            account != address(this)
        ) revert Errors.PoolOwnerOrEARequired();
        return evaluationAgent;
    }

    /**
     * @notice Allow for sensitive pool functions only to be called by
     * the pool owner and the huma owner.
     */
    function onlyPoolOwnerOrHumaOwner(address account) public view {
        if (!hasRole(DEFAULT_ADMIN_ROLE, account) && account != humaConfig.owner()) {
            revert Errors.PoolOwnerOrHumaOwnerRequired();
        }
    }

    function onlyHumaOwner(address account) public view {
        if (account != humaConfig.owner()) {
            revert Errors.HumaOwnerRequired();
        }
    }

    function _checkLiquidityRequirementForPoolOwner(
        address tranche,
        uint256 balance
    ) internal view {
        uint256 minDepositAmount = _poolSettings.minDepositAmount;
        if (tranche == juniorTranche) {
            // For the junior tranche, the pool owner's liquidity must be higher than both the
            // absolute asset threshold and the the relative threshold determined by the pool liquidity cap.
            uint256 minRelativeBalance = (_lpConfig.liquidityCap *
                _adminRnR.liquidityRateInBpsByPoolOwner) / HUNDRED_PERCENT_IN_BPS;
            if (balance < Math.max(minDepositAmount, minRelativeBalance)) {
                revert Errors.PoolOwnerInsufficientLiquidity();
            }
        }
        if (
            tranche == seniorTranche &&
            _lpConfig.maxSeniorJuniorRatio > 0 &&
            balance < minDepositAmount
        ) {
            // If the `maxSeniorJuniorRatio` is 0, then the senior tranche is disabled, thus the pool owner
            // does not have to deposit liquidity. Otherwise, the pool owner must maintain a balance of at least
            // `minDepositAmount` to prevent inflation attacks.
            revert Errors.PoolOwnerInsufficientLiquidity();
        }
    }

    function _checkLiquidityRequirementForEA(uint256 balance) internal view {
        uint256 minLiquidityRequirement = (_lpConfig.liquidityCap *
            _adminRnR.liquidityRateInBpsByEA) / HUNDRED_PERCENT_IN_BPS;
        if (balance < minLiquidityRequirement)
            revert Errors.EvaluationAgentInsufficientLiquidity();
    }

    /**
     * @notice "Modifier" function that limits access to pool owner or Huma protocol owner.
     */
    function _onlyPoolOwnerOrHumaOwner() internal view {
        onlyPoolOwnerOrHumaOwner(msg.sender);
    }

    function _authorizeUpgrade(address) internal view override {
        onlyHumaOwner(msg.sender);
    }
}
