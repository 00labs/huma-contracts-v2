// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IPoolFeeManager} from "./interfaces/IPoolFeeManager.sol";
import {IPool} from "./interfaces/IPool.sol";
import {IFirstLossCover} from "./interfaces/IFirstLossCover.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {AFFILIATE_FIRST_LOSS_COVER_INDEX, HUNDRED_PERCENT_IN_BPS, JUNIOR_TRANCHE, SENIOR_TRANCHE} from "./SharedDefs.sol";
import {HumaConfig} from "./HumaConfig.sol";
import {Errors} from "./Errors.sol";
import {PayPeriodDuration} from "./credit/CreditStructs.sol";

struct PoolSettings {
    // The maximum credit line for a borrower in terms of the amount of poolTokens
    uint96 maxCreditLine;
    // The number of months in one pay period
    PayPeriodDuration payPeriodDuration;
    // The duration of a credit line without an initial drawdown
    uint16 creditApprovalExpirationInDays;
    // The grace period before a late fee can be charged, in the unit of number of days
    uint8 latePaymentGracePeriodInDays;
    // The grace period before a default can be triggered, in months. This can be 0.
    uint16 defaultGracePeriodInMonths;
    // Percentage (in basis points) of the receivable amount applied towards available credit
    uint16 receivableRequiredInBps;
    // Specifies the max credit line as a percentage (in basis points) of the receivable amount.
    // E.g., for a receivable of $100 with an advance rate of 9000 bps, the credit line can be up to $90.
    uint16 advanceRateInBps;
    // Whether the pool is exclusive to one borrower
    bool singleBorrower;
    // Whether the dues are combined into one credit if the borrower has multiple receivables
    bool singleCreditPerBorrower;
}

/**
 * @notice Rewards and Responsibilities for various admins
 */
struct AdminRnR {
    // Percentage of pool income allocated to EA
    uint16 rewardRateInBpsForEA;
    // Percentage of pool income allocated to Pool Owner
    uint16 rewardRateInBpsForPoolOwner;
    // Percentage of the _liquidityCap to be contributed by EA
    uint16 liquidityRateInBpsByEA;
    // Percentage of the _liquidityCap to be contributed by Pool Owner
    uint16 liquidityRateInBpsByPoolOwner;
    uint16 rewardRateInBpsForPoolCover;
    uint16 liquidityRateInBpsByPoolCover;
}

struct LPConfig {
    // whether approval is required for an LP to participate
    bool permissioned;
    // The max liquidity allowed for the pool.
    uint96 liquidityCap;
    // How long a lender has to wait after the last deposit before they can withdraw
    uint8 withdrawalLockoutInMonths;
    // The upper bound of senior-to-junior ratio allowed
    uint8 maxSeniorJuniorRatio;
    // The fixed yield for senior tranche. Either this or tranchesRiskAdjustmentInBps is non-zero
    uint16 fixedSeniorYieldInBps;
    // Percentage of yield to be shifted from senior to junior. Either this or fixedSeniorYieldInBps is non-zero
    uint16 tranchesRiskAdjustmentInBps;
}

struct FrontLoadingFeesStructure {
    // Part of platform fee, charged as a flat amount when a borrow happens
    uint96 frontLoadingFeeFlat;
    // Part of platform fee, charged as a % of the borrowing amount when a borrow happens
    uint16 frontLoadingFeeBps;
}

struct FeeStructure {
    // Expected yield in basis points
    uint16 yieldInBps;
    // The min % of the outstanding principal to be paid in the statement for each each period
    uint16 minPrincipalRateInBps;
    // Part of late fee, charged as a flat amount when a payment is late
    uint96 lateFeeFlat;
    // Part of late fee, charged as % of the totaling outstanding balance when a payment is late
    uint16 lateFeeBps;
    // Membership fee per pay period. It is a flat fee
    uint96 membershipFee;
}

struct FirstLossCoverConfig {
    // The percentage of a default to be paid by the first loss cover
    uint16 coverRateInBps;
    // The max amount that first loss cover can spend on one default
    uint96 coverCap;
    // The max liquidity allowed for the first loss cover
    uint96 liquidityCap;
    // The max percent of pool assets that first loss cover can reach
    uint16 maxPercentOfPoolValueInBps;
    // riskYieldMultiplier is used to adjust the yield of the first loss covers relative to each other.
    // The higher the multiplier, the higher the yield the first loss cover will get during profit distribution
    // compared to other first loss covers.
    uint16 riskYieldMultiplier;
}

interface ITrancheVaultLike {
    function totalAssetsOf(address account) external view returns (uint256 assets);
}

contract PoolConfig is AccessControl, Initializable, UUPSUpgradeable {
    bytes32 public constant POOL_OPERATOR_ROLE = keccak256("POOL_OPERATOR");

    //using SafeERC20 for IERC20;

    string public poolName;

    address public pool;
    address public poolSafe;
    address public seniorTranche;
    address public juniorTranche;
    address public tranchesPolicy;
    address public epochManager;
    address public credit;
    address public poolFeeManager;
    address public calendar;

    address public creditDueManager;

    HumaConfig public humaConfig;

    // The ERC20 token this pool manages
    address public underlyingToken;

    // Evaluation Agents (EA) are the risk underwriting agents that associated with the pool.
    address public evaluationAgent;
    uint256 public evaluationAgentId;

    // The maximum number of first loss covers we allow is 16, which should be sufficient for now.
    address[16] internal _firstLossCovers;
    mapping(address => FirstLossCoverConfig) internal _firstLossCoverConfigs;

    PoolSettings internal _poolSettings;
    LPConfig internal _lpConfig;
    AdminRnR internal _adminRnR;
    FrontLoadingFeesStructure internal _frontFees;
    FeeStructure internal _feeStructure;

    // Address for the account that handles the treasury functions for the pool owner:
    // liquidity deposits, liquidity withdrawals, and reward withdrawals
    address public poolOwnerTreasury;

    address public receivableAsset;

    event YieldChanged(uint256 aprInBps, address by);
    event CreditApprovalExpirationChanged(uint256 durationInDays, address by);
    event LatePaymentGracePeriodChanged(uint256 gracePeriodInDays, address by);
    event EARewardsAndLiquidityChanged(
        uint256 rewardRate,
        uint256 liquidityRate,
        address indexed by
    );
    event EvaluationAgentChanged(address oldEA, address newEA, uint256 newEAId, address by);
    event EvaluationAgentRewardsWithdrawn(address receiver, uint256 amount, address by);
    event PoolFeeManagerChanged(address poolFeeManager, address by);
    event HumaConfigChanged(address humaConfig, address by);

    event MaxCreditLineChanged(uint256 maxCreditLine, address by);
    event PoolChanged(address pool, address by);
    event PoolDefaultGracePeriodChanged(uint256 gracePeriodInMonths, address by);
    event PoolLiquidityCapChanged(uint256 liquidityCap, address by);
    event PoolPayPeriodChanged(PayPeriodDuration payPeriodDuration, address by);
    event PoolNameChanged(string name, address by);
    event PoolOwnerRewardsAndLiquidityChanged(
        uint256 rewardRate,
        uint256 liquidityRate,
        address indexed by
    );
    event PoolOwnerTreasuryChanged(address treasury, address indexed by);
    event PoolFlexCallChanged(bool enabled, uint256 windowInEpoch, address by);
    event PoolUnderlyingTokenChanged(address underlyingToken, address by);
    event TranchesChanged(address seniorTranche, address juniorTranche, address by);
    event PoolSafeChanged(address poolSafe, address by);
    event TranchesPolicyChanged(address tranchesPolicy, address by);
    event EpochManagerChanged(address epochManager, address by);
    event CreditChanged(address credit, address by);
    event FirstLossCoverChanged(
        uint8 index,
        address firstLossCover,
        uint16 coverRateInBps,
        uint96 coverCap,
        uint96 liquidityCap,
        uint16 maxPercentOfPoolValueInBps,
        uint16 riskYieldMultiplier,
        address by
    );
    event CalendarChanged(address calendar, address by);
    event ReceivableAssetChanged(address receivableAsset, address by);

    event PoolRewardsWithdrawn(address receiver, uint256 amount);
    event ProtocolRewardsWithdrawn(address receiver, uint256 amount, address by);
    event ReceivableRequiredInBpsChanged(uint256 receivableRequiredInBps, address by);
    event AdvanceRateInBpsChanged(uint256 advanceRateInBps, address by);
    event WithdrawalLockoutPeriodChanged(uint256 lockoutPeriodInMonths, address by);

    event LPConfigChanged(
        bool permissioned,
        uint96 liquidityCap,
        uint8 withdrawalLockoutInMonths,
        uint8 maxSeniorJuniorRatio,
        uint16 fixedSeniorYieldInBps,
        uint16 tranchesRiskAdjustmentInBps,
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
        uint96 lateFeeFlat,
        uint16 lateFeeBps,
        uint96 membershipFee,
        address by
    );

    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    /**
     * @notice Initialize the pool configuration
     * @param _poolName The name of the pool
     * @param _contracts The addresses of the contracts that are used by the pool
     *   _contracts[0]: address of HumaConfig
     *   _contracts[1]: address of underlyingToken
     *   _contracts[2]: address of calendar
     *   _contracts[3]: address of pool
     *   _contracts[4]: address of poolSafe
     *   _contracts[5]: address of poolFeeManager
     *   _contracts[6]: address of tranchesPolicy
     *   _contracts[7]: address of epochManager
     *   _contracts[8]: address of seniorTranche
     *   _contracts[9]: address of juniorTranche
     *   _contracts[10]: address of credit
     *   _contracts[11]: address of creditDueManager
     */

    function initialize(
        string memory _poolName,
        address[] calldata _contracts
    ) public initializer {
        onlyPoolOwner(msg.sender);

        poolName = _poolName;

        address addr = _contracts[0];
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        humaConfig = HumaConfig(addr);

        addr = _contracts[1];
        if (!humaConfig.isAssetValid(addr))
            revert Errors.underlyingTokenNotApprovedForHumaProtocol();
        underlyingToken = addr;

        addr = _contracts[2];
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        calendar = addr;

        addr = _contracts[3];
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        pool = addr;

        addr = _contracts[4];
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        poolSafe = addr;

        addr = _contracts[5];
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        poolFeeManager = addr;

        addr = _contracts[6];
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        tranchesPolicy = addr;

        addr = _contracts[7];
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        epochManager = addr;

        addr = _contracts[8];
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        seniorTranche = addr;

        addr = _contracts[9];
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        juniorTranche = addr;

        addr = _contracts[10];
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        credit = addr;

        addr = _contracts[11];
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        creditDueManager = addr;

        // Default values for the pool configurations. The pool owners are expected to reset
        // these values when setting up the pools. Setting these default values to avoid
        // strange behaviors when the pool owner missed setting up these configurations.
        PoolSettings memory tempPoolSettings = _poolSettings;
        tempPoolSettings.payPeriodDuration = PayPeriodDuration.Monthly;
        tempPoolSettings.receivableRequiredInBps = 10000; // 100%
        tempPoolSettings.advanceRateInBps = 8000; // 80%
        tempPoolSettings.latePaymentGracePeriodInDays = 5;
        tempPoolSettings.defaultGracePeriodInMonths = 3; // 3 months
        _poolSettings = tempPoolSettings;

        AdminRnR memory adminRnRConfig = _adminRnR;
        adminRnRConfig.rewardRateInBpsForEA = 300; // 3%
        adminRnRConfig.rewardRateInBpsForPoolOwner = 200; // 2%
        adminRnRConfig.liquidityRateInBpsByEA = 200; // 2%
        adminRnRConfig.liquidityRateInBpsByPoolOwner = 200; // 2%
        _adminRnR = adminRnRConfig;

        LPConfig memory config = _lpConfig;
        config.maxSeniorJuniorRatio = 4; // senior : junior = 4:1
        _lpConfig = config;

        __UUPSUpgradeable_init();
    }

    function getTrancheLiquidityCap(uint256 index) external view returns (uint256 cap) {
        LPConfig memory config = _lpConfig;
        if (index == SENIOR_TRANCHE) {
            cap =
                (config.liquidityCap * config.maxSeniorJuniorRatio) /
                (config.maxSeniorJuniorRatio + 1);
        } else if (index == JUNIOR_TRANCHE) {
            cap = config.liquidityCap / (config.maxSeniorJuniorRatio + 1);
        } else {
            // We only have two tranches for now.
            assert(false);
        }
    }

    /**
     * @notice change the default APR for the pool
     * @param _yieldInBps expected yield in basis points, use 500 for 5%
     */
    function setYield(uint256 _yieldInBps) external {
        _onlyOwnerOrHumaMasterAdmin();
        _feeStructure.yieldInBps = uint16(_yieldInBps);
        emit YieldChanged(_yieldInBps, msg.sender);
    }

    function setCreditApprovalExpiration(uint256 durationInDays) external {
        _onlyOwnerOrHumaMasterAdmin();
        _poolSettings.creditApprovalExpirationInDays = uint16(durationInDays);
        emit CreditApprovalExpirationChanged(durationInDays, msg.sender);
    }

    function setLatePaymentGracePeriodInDays(uint256 gracePeriodInDays) external {
        _onlyOwnerOrHumaMasterAdmin();
        _poolSettings.latePaymentGracePeriodInDays = uint8(gracePeriodInDays);
        emit LatePaymentGracePeriodChanged(gracePeriodInDays, msg.sender);
    }

    function setPoolOwnerRewardsAndLiquidity(uint256 rewardRate, uint256 liquidityRate) external {
        _onlyOwnerOrHumaMasterAdmin();
        if (rewardRate > HUNDRED_PERCENT_IN_BPS || liquidityRate > HUNDRED_PERCENT_IN_BPS)
            revert Errors.invalidBasisPointHigherThan10000();
        AdminRnR memory tempAdminRnR = _adminRnR;
        if (rewardRate + tempAdminRnR.rewardRateInBpsForEA > HUNDRED_PERCENT_IN_BPS) {
            // Since we split the profit between the pool owner and EA, their combined reward rate cannot exceed 100%.
            revert Errors.adminRewardRateTooHigh();
        }

        tempAdminRnR.rewardRateInBpsForPoolOwner = uint16(rewardRate);
        tempAdminRnR.liquidityRateInBpsByPoolOwner = uint16(liquidityRate);
        _adminRnR = tempAdminRnR;
        emit PoolOwnerRewardsAndLiquidityChanged(rewardRate, liquidityRate, msg.sender);
    }

    function setEARewardsAndLiquidity(uint256 rewardRate, uint256 liquidityRate) external {
        _onlyOwnerOrHumaMasterAdmin();
        if (rewardRate > HUNDRED_PERCENT_IN_BPS || liquidityRate > HUNDRED_PERCENT_IN_BPS)
            revert Errors.invalidBasisPointHigherThan10000();
        AdminRnR memory tempAdminRnR = _adminRnR;
        if (rewardRate + tempAdminRnR.rewardRateInBpsForPoolOwner > HUNDRED_PERCENT_IN_BPS) {
            // Since we split the profit between the pool owner and EA, their combined reward rate cannot exceed 100%.
            revert Errors.adminRewardRateTooHigh();
        }

        tempAdminRnR.rewardRateInBpsForEA = uint16(rewardRate);
        tempAdminRnR.liquidityRateInBpsByEA = uint16(liquidityRate);
        _adminRnR = tempAdminRnR;
        emit EARewardsAndLiquidityChanged(rewardRate, liquidityRate, msg.sender);
    }

    /**
     * @notice Adds an evaluation agent to the list who can approve loans.
     * @param agent the evaluation agent to be added
     */
    function setEvaluationAgent(uint256 eaId, address agent) external {
        if (agent == address(0)) revert Errors.zeroAddressProvided();
        _onlyOwnerOrHumaMasterAdmin();

        if (IERC721(humaConfig.eaNFTContractAddress()).ownerOf(eaId) != agent)
            revert Errors.proposedEADoesNotOwnProvidedEANFT();

        // Transfer the accrued EA income to the old EA's wallet.
        // Decided not to check if there is enough balance in the pool. If there is
        // not enough balance, the transaction will fail. PoolOwner has to find enough
        // liquidity to pay the EA before replacing it.
        address oldEA = evaluationAgent;
        if (oldEA != address(0)) {
            IPoolFeeManager feeManager = IPoolFeeManager(poolFeeManager);
            (, , uint256 eaWithdrawable) = feeManager.getWithdrawables();
            feeManager.withdrawEAFee(eaWithdrawable);
        }

        // Make sure the new EA has met the liquidity requirements.
        if (IPool(pool).isPoolOn()) {
            if (
                !IFirstLossCover(_firstLossCovers[AFFILIATE_FIRST_LOSS_COVER_INDEX]).isSufficient(
                    agent
                )
            ) {
                revert Errors.lessThanRequiredCover();
            }
            ITrancheVaultLike juniorTrancheVault = ITrancheVaultLike(juniorTranche);
            checkLiquidityRequirementForEA(juniorTrancheVault.totalAssetsOf(agent));
        }

        evaluationAgent = agent;
        evaluationAgentId = eaId;

        emit EvaluationAgentChanged(oldEA, agent, eaId, msg.sender);
    }

    function setPoolFeeManager(address _poolFeeManager) external {
        _onlyOwnerOrHumaMasterAdmin();
        if (_poolFeeManager == address(0)) revert Errors.zeroAddressProvided();
        poolFeeManager = _poolFeeManager;
        emit PoolFeeManagerChanged(_poolFeeManager, msg.sender);
    }

    function setHumaConfig(address _humaConfig) external {
        _onlyOwnerOrHumaMasterAdmin();
        if (_humaConfig == address(0)) revert Errors.zeroAddressProvided();
        humaConfig = HumaConfig(_humaConfig);
        emit HumaConfigChanged(_humaConfig, msg.sender);
    }

    /**
     * @notice Sets the min and max of each loan/credit allowed by the pool.
     * @param creditLine the max amount of a credit line
     */
    function setMaxCreditLine(uint256 creditLine) external {
        _onlyOwnerOrHumaMasterAdmin();
        if (creditLine == 0) revert Errors.zeroAmountProvided();
        if (creditLine >= 2 ** 96) revert Errors.creditLineTooHigh();
        _poolSettings.maxCreditLine = uint96(creditLine);
        emit MaxCreditLineChanged(creditLine, msg.sender);
    }

    function setPool(address _pool) external {
        _onlyOwnerOrHumaMasterAdmin();
        if (_pool == address(0)) revert Errors.zeroAddressProvided();
        pool = _pool;
        emit PoolChanged(_pool, msg.sender);
    }

    /**
     * Sets the default grace period for this pool.
     * @param gracePeriod the desired grace period in days.
     */
    function setPoolDefaultGracePeriod(uint256 gracePeriod) external {
        _onlyOwnerOrHumaMasterAdmin();
        _poolSettings.defaultGracePeriodInMonths = uint16(gracePeriod);
        emit PoolDefaultGracePeriodChanged(gracePeriod, msg.sender);
    }

    /**
     * @notice Sets the cap of the pool liquidity.
     * @param liquidityCap the upper bound that the pool accepts liquidity from the depositors
     */
    function setPoolLiquidityCap(uint256 liquidityCap) external {
        _onlyOwnerOrHumaMasterAdmin();
        if (liquidityCap == 0) revert Errors.zeroAmountProvided();
        _lpConfig.liquidityCap = uint96(liquidityCap);
        emit PoolLiquidityCapChanged(liquidityCap, msg.sender);
    }

    function setPoolPayPeriod(PayPeriodDuration duration) external {
        _onlyOwnerOrHumaMasterAdmin();
        PoolSettings memory _settings = _poolSettings;
        _settings.payPeriodDuration = duration;
        _poolSettings = _settings;
        emit PoolPayPeriodChanged(duration, msg.sender);
    }

    /**
     * @notice Change pool name
     */
    function setPoolName(string memory newName) external {
        _onlyOwnerOrHumaMasterAdmin();
        poolName = newName;
        emit PoolNameChanged(newName, msg.sender);
    }

    function setPoolOwnerTreasury(address _poolOwnerTreasury) external {
        _onlyOwnerOrHumaMasterAdmin();
        if (_poolOwnerTreasury == address(0)) revert Errors.zeroAddressProvided();
        poolOwnerTreasury = _poolOwnerTreasury;
        emit PoolOwnerTreasuryChanged(_poolOwnerTreasury, msg.sender);
    }

    function setPoolUnderlyingToken(address _underlyingToken) external {
        _onlyOwnerOrHumaMasterAdmin();
        if (_underlyingToken == address(0)) revert Errors.zeroAddressProvided();
        underlyingToken = _underlyingToken;
        emit PoolUnderlyingTokenChanged(_underlyingToken, msg.sender);
    }

    function setTranches(address _seniorTranche, address _juniorTranche) external {
        _onlyOwnerOrHumaMasterAdmin();
        if (_seniorTranche == address(0) || _juniorTranche == address(0))
            revert Errors.zeroAddressProvided();
        seniorTranche = _seniorTranche;
        juniorTranche = _juniorTranche;
        emit TranchesChanged(_seniorTranche, _juniorTranche, msg.sender);
    }

    function setPoolSafe(address _poolSafe) external {
        _onlyOwnerOrHumaMasterAdmin();
        if (_poolSafe == address(0)) revert Errors.zeroAddressProvided();
        poolSafe = _poolSafe;
        emit PoolSafeChanged(poolSafe, msg.sender);
    }

    function setTranchesPolicy(address _tranchesPolicy) external {
        _onlyOwnerOrHumaMasterAdmin();
        if (_tranchesPolicy == address(0)) revert Errors.zeroAddressProvided();
        tranchesPolicy = _tranchesPolicy;
        emit TranchesPolicyChanged(_tranchesPolicy, msg.sender);
    }

    function setEpochManager(address _epochManager) external {
        _onlyOwnerOrHumaMasterAdmin();
        if (_epochManager == address(0)) revert Errors.zeroAddressProvided();
        epochManager = _epochManager;
        emit EpochManagerChanged(epochManager, msg.sender);
    }

    function setCredit(address _credit) external {
        _onlyOwnerOrHumaMasterAdmin();
        if (_credit == address(0)) revert Errors.zeroAddressProvided();
        credit = _credit;
        emit CreditChanged(_credit, msg.sender);
    }

    //* todo passing the parameter inside the struct instead of the struct itself.
    function setFirstLossCover(
        uint8 index,
        address firstLossCover,
        FirstLossCoverConfig memory config
    ) external {
        _onlyOwnerOrHumaMasterAdmin();
        _firstLossCovers[index] = firstLossCover;
        _firstLossCoverConfigs[firstLossCover] = config;

        emit FirstLossCoverChanged(
            index,
            firstLossCover,
            config.coverRateInBps,
            config.coverCap,
            config.liquidityCap,
            config.maxPercentOfPoolValueInBps,
            config.riskYieldMultiplier,
            msg.sender
        );
    }

    function setCalendar(address _calendar) external {
        _onlyOwnerOrHumaMasterAdmin();
        if (_calendar == address(0)) revert Errors.zeroAddressProvided();
        calendar = _calendar;
        emit CalendarChanged(_calendar, msg.sender);
    }

    function setReceivableAsset(address _receivableAsset) external {
        _onlyOwnerOrHumaMasterAdmin();
        if (_receivableAsset == address(0)) revert Errors.zeroAddressProvided();
        receivableAsset = _receivableAsset;
        emit ReceivableAssetChanged(_receivableAsset, msg.sender);
    }

    /**
     * @notice Set the receivable rate in terms of basis points.
     * When the rate is higher than 10000, it means the backing is higher than the borrow amount,
     * similar to an over-collateral situation.
     * @param receivableRequiredInBps the percentage in basis points. A percentage over 10000 means over-receivablization.
     */
    function setReceivableRequiredInBps(uint256 receivableRequiredInBps) external {
        _onlyOwnerOrHumaMasterAdmin();
        // note: this rate can be over 10000 when it requires more backing than the credit limit
        _poolSettings.receivableRequiredInBps = uint16(receivableRequiredInBps);
        emit ReceivableRequiredInBpsChanged(receivableRequiredInBps, msg.sender);
    }

    /**
     * @notice Set the advance rate in terms of basis points.
     * The rate cannot exceed 10000 (100%).
     * @param advanceRateInBps the percentage in basis points.
     */
    function setAdvanceRateInBps(uint256 advanceRateInBps) external {
        _onlyOwnerOrHumaMasterAdmin();
        if (advanceRateInBps > 10000) {
            revert Errors.invalidBasisPointHigherThan10000();
        }
        // note: this rate can be over 10000 when it requires more backing than the credit limit
        _poolSettings.advanceRateInBps = uint16(advanceRateInBps);
        emit AdvanceRateInBpsChanged(advanceRateInBps, msg.sender);
    }

    /**
     * Sets withdrawal lockout period after the lender makes the last deposit
     * @param lockoutPeriod the lockout period in terms of days
     */
    function setWithdrawalLockoutPeriod(uint256 lockoutPeriod) external {
        _onlyOwnerOrHumaMasterAdmin();
        _lpConfig.withdrawalLockoutInMonths = uint8(lockoutPeriod);
        emit WithdrawalLockoutPeriodChanged(lockoutPeriod, msg.sender);
    }

    function setLPConfig(LPConfig calldata lpConfig) external {
        _onlyOwnerOrHumaMasterAdmin();
        _lpConfig = lpConfig;
        emit LPConfigChanged(
            lpConfig.permissioned,
            lpConfig.liquidityCap,
            lpConfig.withdrawalLockoutInMonths,
            lpConfig.maxSeniorJuniorRatio,
            lpConfig.fixedSeniorYieldInBps,
            lpConfig.tranchesRiskAdjustmentInBps,
            msg.sender
        );
    }

    function setFrontLoadingFees(FrontLoadingFeesStructure calldata frontFees) external {
        _onlyOwnerOrHumaMasterAdmin();
        _frontFees = frontFees;
        emit FrontLoadingFeesChanged(
            frontFees.frontLoadingFeeFlat,
            frontFees.frontLoadingFeeBps,
            msg.sender
        );
    }

    function setFeeStructure(FeeStructure calldata feeStructure) external {
        _onlyOwnerOrHumaMasterAdmin();
        _feeStructure = feeStructure;
        emit FeeStructureChanged(
            feeStructure.yieldInBps,
            feeStructure.minPrincipalRateInBps,
            feeStructure.lateFeeFlat,
            feeStructure.lateFeeBps,
            feeStructure.membershipFee,
            msg.sender
        );
    }

    /**
     * @notice Checks to make sure both EA and pool owner treasury meet the pool's first loss cover requirements
     */
    function checkFirstLossCoverRequirementsForAdmin() public view {
        IFirstLossCover firstLossCover = IFirstLossCover(
            _firstLossCovers[AFFILIATE_FIRST_LOSS_COVER_INDEX]
        );
        if (!firstLossCover.isSufficient(poolOwnerTreasury)) revert Errors.lessThanRequiredCover();
        if (!firstLossCover.isSufficient(evaluationAgent)) revert Errors.lessThanRequiredCover();
    }

    /**
     * @notice Checks whether the pool owner and EA has met their first loss cover liquidity requirements
     * when they try to withdraw liquidity from other tranches.
     * @param lender The lender address
     */
    function checkFirstLossCoverRequirementsForRedemption(address lender) public view {
        if (lender == evaluationAgent || lender == poolOwnerTreasury) {
            IFirstLossCover firstLossCover = IFirstLossCover(
                _firstLossCovers[AFFILIATE_FIRST_LOSS_COVER_INDEX]
            );
            if (!firstLossCover.isSufficient(lender)) revert Errors.lessThanRequiredCover();
        }
    }

    function checkLiquidityRequirementForPoolOwner(uint256 balance) public view {
        if (balance < _getRequiredLiquidityForPoolOwner())
            revert Errors.poolOwnerNotEnoughLiquidity();
    }

    function checkLiquidityRequirementForEA(uint256 balance) public view {
        if (balance < _getRequiredLiquidityForEA())
            revert Errors.evaluationAgentNotEnoughLiquidity();
    }

    /**
     * @notice Checks whether both the EA and the pool owner treasury have met the pool's liquidity requirements
     */
    function checkLiquidityRequirements() public view {
        ITrancheVaultLike juniorTrancheVault = ITrancheVaultLike(juniorTranche);
        checkLiquidityRequirementForPoolOwner(juniorTrancheVault.totalAssetsOf(poolOwnerTreasury));
        checkLiquidityRequirementForEA(juniorTrancheVault.totalAssetsOf(evaluationAgent));
    }

    /**
     * @notice Checks whether the lender can still meet the liquidity requirements after redemption.
     * @param lender The lender address
     * @param trancheVault The tranche vault address
     * @param newBalance The resulting balance of the lender after redemption
     */
    function checkLiquidityRequirementForRedemption(
        address lender,
        address trancheVault,
        uint256 newBalance
    ) public view {
        if (trancheVault != juniorTranche) {
            // There is no liquidity requirement for the senior tranche.
            return;
        }
        if (lender == poolOwnerTreasury) {
            checkLiquidityRequirementForPoolOwner(newBalance);
        }
        if (lender == evaluationAgent) {
            checkLiquidityRequirementForEA(newBalance);
        }
    }

    /**
     * Returns a summary information of the pool.
     * @return token the address of the pool token
     * @return yieldInBps the default annual percentage yield of the pool, measured in basis points
     * @return payPeriodDuration the pay period duration for the pool
     * @return maxCreditAmount the max amount for the credit line
     * @return liquidityCap The liquidity cap of the pool
     * @return name The name of the pool
     * @return symbol The symbol of the underlying token of the pool
     * @return decimals The number of decimals of the underlying token of the pool
     * @return eaId The tokenId of the EA NFT
     * @return eaNFTAddress The contract address of the EA NFT
     */
    function getPoolSummary()
        external
        view
        returns (
            address token,
            uint256 yieldInBps,
            PayPeriodDuration payPeriodDuration,
            uint256 maxCreditAmount,
            uint256 liquidityCap,
            string memory name,
            string memory symbol,
            uint8 decimals,
            uint256 eaId,
            address eaNFTAddress
        )
    {
        IERC20Metadata erc20Contract = IERC20Metadata(address(underlyingToken));
        return (
            address(underlyingToken),
            _feeStructure.yieldInBps,
            _poolSettings.payPeriodDuration,
            _poolSettings.maxCreditLine,
            _lpConfig.liquidityCap,
            erc20Contract.name(),
            erc20Contract.symbol(),
            erc20Contract.decimals(),
            evaluationAgentId,
            humaConfig.eaNFTContractAddress()
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

    /**
     * @notice Gets the fee structure for the pool
     */
    function getFees()
        external
        view
        virtual
        returns (uint256 _lateFeeFlat, uint256 _lateFeeBps, uint256 _membershipFee)
    {
        return (_feeStructure.lateFeeFlat, _feeStructure.lateFeeBps, _feeStructure.membershipFee);
    }

    function getMinPrincipalRateInBps() external view virtual returns (uint256 _minPrincipalRate) {
        return _feeStructure.minPrincipalRateInBps;
    }

    function onlyPoolOwner(address account) public view {
        // Treat DEFAULT_ADMIN_ROLE role as owner role
        if (!hasRole(DEFAULT_ADMIN_ROLE, account)) revert Errors.notPoolOwner();
    }

    /**
     * @notice "Modifier" function that limits access to pool owner or EA.
     */
    function onlyPoolOwnerOrEA(address account) public view returns (address) {
        if (
            !hasRole(DEFAULT_ADMIN_ROLE, account) &&
            account != evaluationAgent &&
            account != address(this)
        ) revert Errors.notPoolOwnerOrEA();
        return evaluationAgent;
    }

    /**
     * @notice Allow for sensitive pool functions only to be called by
     * the pool owner and the huma master admin
     */
    function onlyOwnerOrHumaMasterAdmin(address account) public view {
        if (!hasRole(DEFAULT_ADMIN_ROLE, account) && account != humaConfig.owner()) {
            revert Errors.permissionDeniedNotAdmin();
        }
    }

    function onlyHumaMasterAdmin(address account) public view {
        if (account != humaConfig.owner()) {
            revert Errors.permissionDeniedNotAdmin();
        }
    }

    function onlyPool(address account) external view {
        if (account != pool) revert Errors.notPool();
    }

    function onlyProtocolAndPoolOn() external view {
        if (humaConfig.paused()) revert Errors.protocolIsPaused();
        if (!IPool(pool).isPoolOn()) revert Errors.poolIsNotOn();
    }

    function onlyPoolOperator(address account) external view {
        if (!hasRole(POOL_OPERATOR_ROLE, account)) revert Errors.poolOperatorRequired();
    }

    /**
     * @notice "Modifier" function that limits access to pool owner or Huma protocol owner
     */
    function _onlyOwnerOrHumaMasterAdmin() internal view {
        onlyOwnerOrHumaMasterAdmin(msg.sender);
    }

    function _getRequiredLiquidityForPoolOwner() internal view returns (uint256 amount) {
        return
            (_lpConfig.liquidityCap * _adminRnR.liquidityRateInBpsByPoolOwner) /
            HUNDRED_PERCENT_IN_BPS;
    }

    function _getRequiredLiquidityForEA() internal view returns (uint256 amount) {
        return
            (_lpConfig.liquidityCap * _adminRnR.liquidityRateInBpsByEA) / HUNDRED_PERCENT_IN_BPS;
    }

    function _authorizeUpgrade(address) internal view override {
        onlyHumaMasterAdmin(msg.sender);
    }
}
