// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.23;

import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {PoolConfig, FirstLossCoverConfig, PoolSettings} from "../common/PoolConfig.sol";
import {PoolSettings, LPConfig, FrontLoadingFeesStructure, FeeStructure} from "../common/PoolConfig.sol";
import {Errors} from "../common/Errors.sol";
import {PayPeriodDuration} from "../common/SharedDefs.sol";
import {SENIOR_TRANCHE, JUNIOR_TRANCHE} from "../common/SharedDefs.sol";
import {BORROWER_LOSS_COVER_INDEX, INSURANCE_LOSS_COVER_INDEX, ADMIN_LOSS_COVER_INDEX} from "../common/SharedDefs.sol";
import {LibTimelockController} from "./library/LibTimelockController.sol";

interface IPoolConfigCacheLike {
    function initialize(address poolConfig) external;
}

interface IVaultLike {
    function initialize(
        string memory name,
        string memory symbol,
        PoolConfig _poolConfig,
        uint8 seniorTrancheOrJuniorTranche
    ) external;
}

contract PoolFactory is Initializable, AccessControlUpgradeable, UUPSUpgradeable {
    /**
     * @notice Represents the status of a pool for bookkeeping
     */
    enum PoolStatus {
        Created, // the pool is created but not initialized yet
        Initialized, // the pool is initialized and ready for use
        Closed // the pool is closed and not in operation anymore
    }

    // Struct to store information about a pool
    struct PoolRecord {
        uint256 poolId;
        address poolAddress;
        string poolName;
        PoolStatus poolStatus;
        address poolConfigAddress;
        address poolTimelock;
    }

    // only deployer can create new pools
    bytes32 public constant DEPLOYER_ROLE = keccak256("DEPLOYER_ROLE");

    // poolId
    uint256 public poolId;

    // protocol and implementation addresses
    address public humaConfigAddress;
    address public calendarAddress;
    address public fixedSeniorYieldTranchesPolicyImplAddress;
    address public riskAdjustedTranchesPolicyImplAddress;

    // Credit implementation addresses
    address public creditLineImplAddress;
    address public receivableBackedCreditLineImplAddress;
    address public receivableFactoringCreditImplAddress;
    address public creditLineManagerImplAddress;
    address public receivableBackedCreditLineManagerImplAddress;
    address public receivableFactoringCreditManagerImplAddress;

    // pool implementation addresses
    address public poolConfigImplAddress;
    address public poolFeeManagerImplAddress;
    address public poolImplAddress;
    address public poolSafeImplAddress;
    address public firstLossCoverImplAddress;
    address public epochManagerImplAddress;
    address public trancheVaultImplAddress;
    address public creditDueManagerImplAddress;

    // huma implementation of receivable
    address public receivableImpl;

    // poolId => PoolRecord
    mapping(uint256 => PoolRecord) private pools;

    /**
     * @dev This empty reserved space is put in place to allow future versions to add new
     * variables without shifting down storage in the inheritance chain.
     * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
     */
    uint256[100] private __gap;

    // events for implementation address changes
    event PoolConfigImplChanged(address oldAddress, address newAddress);
    event PoolFeeManagerImplChanged(address oldAddress, address newAddress);
    event PoolImplChanged(address oldAddress, address newAddress);
    event PoolSafeImplChanged(address oldAddress, address newAddress);
    event FirstLossCoverImplChanged(address oldAddress, address newAddress);
    event TranchesPolicyImplChanged(address oldAddress, address newAddress);
    event EpochManagerImplChanged(address oldAddress, address newAddress);
    event TrancheVaultImplChanged(address oldAddress, address newAddress);
    event CreditDueManagerImplChanged(address oldAddress, address newAddress);
    event ReceivableImplChanged(address oldAddress, address newAddress);
    event CalendarAddressChanged(address oldAddress, address newAddress);
    event ReceivableBackedCreditLineImplChanged(address oldAddress, address newAddress);
    event FixedSeniorYieldTranchesPolicyImplChanged(address oldAddress, address newAddress);
    event RiskAdjustedTranchesPolicyImpl(address oldAddress, address newAddress);
    event CreditLineManagerImplChanged(address oldAddress, address newAddress);
    event ReceivableBackedCreditLineManagerImplChanged(address oldAddress, address newAddress);
    event ReceivableFactoringCreditManagerImplChanged(address oldAddress, address newAddress);
    event CreditLineImplChanged(address oldAddress, address newAddress);
    event ReceivableFactoringCreditImplChanged(address oldAddress, address newAddress);

    // deployer events
    event DeployerAdded(address deployerAddress);
    event DeployerRemoved(address deployerAddress);

    // Pool events
    event PoolCreated(address poolAddress, string poolName);
    event PoolAdded(uint256 poolId, address poolAddress, string poolName);
    event PoolStatusUpdated(
        uint256 poolId,
        address poolAddress,
        string poolName,
        PoolStatus oldAddress,
        PoolStatus newStatus
    );

    event ReceivableCreated(address receivableAddress);

    event TimelockAddedToPool(uint256 poolId, address poolAddress, address timelockAddress);

    constructor() {
        _disableInitializers();
    }

    /**
     * @dev Initialize function grants DEFAULT_ADMIN_ROLE and DEPLOYER_ROLE to the deployer.
     * @dev After deployment and initial setup of the factory, the deploy should grant the
     * DEFAULT_ADMIN_ROLE to the protocol owner, meanwhile renounce the role from the deployer.
     * @param _humaConfigAddress The address of the HumaConfig contract.
     */
    function initialize(address _humaConfigAddress) external initializer {
        poolId = 0;
        humaConfigAddress = _humaConfigAddress;
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(DEPLOYER_ROLE, msg.sender);
        __AccessControl_init();
        __UUPSUpgradeable_init();
    }

    // Add a deployer account
    function addDeployer(address account) external {
        _notZeroAddress(account);
        _onlyFactoryAdmin(msg.sender);
        _grantRole(DEPLOYER_ROLE, account);
        emit DeployerAdded(account);
    }

    // Remove a deployer account
    function removeDeployer(address account) external {
        _onlyFactoryAdmin(msg.sender);
        _revokeRole(DEPLOYER_ROLE, account);
        emit DeployerRemoved(account);
    }

    // set a calendar address for the factory, so the newly deployed pool will use this calendar
    function setCalendarAddress(address newAddress) external {
        _onlyFactoryAdmin(msg.sender);
        _notZeroAddress(newAddress);
        address oldAddress = calendarAddress;
        calendarAddress = newAddress;
        emit CalendarAddressChanged(oldAddress, newAddress);
    }

    /**
     * @dev For protocol owner to set the implementation addresses
     */
    function setFixedSeniorYieldTranchesPolicyImplAddress(address newAddress) external {
        _onlyFactoryAdmin(msg.sender);
        _notZeroAddress(newAddress);
        address oldAddress = fixedSeniorYieldTranchesPolicyImplAddress;
        fixedSeniorYieldTranchesPolicyImplAddress = newAddress;
        emit FixedSeniorYieldTranchesPolicyImplChanged(oldAddress, newAddress);
    }

    function setRiskAdjustedTranchesPolicyImplAddress(address newAddress) external {
        _onlyFactoryAdmin(msg.sender);
        _notZeroAddress(newAddress);
        address oldAddress = riskAdjustedTranchesPolicyImplAddress;
        riskAdjustedTranchesPolicyImplAddress = newAddress;
        emit RiskAdjustedTranchesPolicyImpl(oldAddress, newAddress);
    }

    function setCreditLineImplAddress(address newAddress) external {
        _onlyFactoryAdmin(msg.sender);
        _notZeroAddress(newAddress);
        address oldAddress = creditLineImplAddress;
        creditLineImplAddress = newAddress;
        emit CreditLineImplChanged(oldAddress, newAddress);
    }

    function setReceivableBackedCreditLineImplAddress(address newAddress) external {
        _onlyFactoryAdmin(msg.sender);
        _notZeroAddress(newAddress);
        address oldAddress = receivableBackedCreditLineImplAddress;
        receivableBackedCreditLineImplAddress = newAddress;
        emit ReceivableBackedCreditLineImplChanged(oldAddress, newAddress);
    }

    function setReceivableFactoringCreditImplAddress(address newAddress) external {
        _onlyFactoryAdmin(msg.sender);
        _notZeroAddress(newAddress);
        address oldAddress = receivableFactoringCreditImplAddress;
        receivableFactoringCreditImplAddress = newAddress;
        emit ReceivableFactoringCreditImplChanged(oldAddress, newAddress);
    }

    function setCreditLineManagerImplAddress(address newAddress) external {
        _onlyFactoryAdmin(msg.sender);
        _notZeroAddress(newAddress);
        address oldAddress = creditLineManagerImplAddress;
        creditLineManagerImplAddress = newAddress;
        emit CreditLineManagerImplChanged(oldAddress, newAddress);
    }

    function setReceivableBackedCreditLineManagerImplAddress(address newAddress) external {
        _onlyFactoryAdmin(msg.sender);
        _notZeroAddress(newAddress);
        address oldAddress = receivableBackedCreditLineManagerImplAddress;
        receivableBackedCreditLineManagerImplAddress = newAddress;
        emit ReceivableBackedCreditLineManagerImplChanged(oldAddress, newAddress);
    }

    function setReceivableFactoringCreditManagerImplAddress(address newAddress) external {
        _onlyFactoryAdmin(msg.sender);
        _notZeroAddress(newAddress);
        address oldAddress = receivableFactoringCreditManagerImplAddress;
        receivableFactoringCreditManagerImplAddress = newAddress;
        emit ReceivableFactoringCreditManagerImplChanged(oldAddress, newAddress);
    }

    function setPoolConfigImplAddress(address newAddress) external {
        _onlyFactoryAdmin(msg.sender);
        _notZeroAddress(newAddress);
        address oldAddress = poolConfigImplAddress;
        poolConfigImplAddress = newAddress;
        emit PoolConfigImplChanged(oldAddress, newAddress);
    }

    function setPoolFeeManagerImplAddress(address newAddress) external {
        _onlyFactoryAdmin(msg.sender);
        _notZeroAddress(newAddress);
        address oldAddress = poolFeeManagerImplAddress;
        poolFeeManagerImplAddress = newAddress;
        emit PoolFeeManagerImplChanged(oldAddress, newAddress);
    }

    function setPoolImplAddress(address newAddress) external {
        _onlyFactoryAdmin(msg.sender);
        _notZeroAddress(newAddress);
        address oldAddress = poolImplAddress;
        poolImplAddress = newAddress;
        emit PoolImplChanged(oldAddress, newAddress);
    }

    function setPoolSafeImplAddress(address newAddress) external {
        _onlyFactoryAdmin(msg.sender);
        _notZeroAddress(newAddress);
        address oldAddress = poolSafeImplAddress;
        poolSafeImplAddress = newAddress;
        emit PoolSafeImplChanged(oldAddress, newAddress);
    }

    function setFirstLossCoverImplAddress(address newAddress) external {
        _onlyFactoryAdmin(msg.sender);
        _notZeroAddress(newAddress);
        address oldAddress = firstLossCoverImplAddress;
        firstLossCoverImplAddress = newAddress;
        emit FirstLossCoverImplChanged(oldAddress, newAddress);
    }

    function setEpochManagerImplAddress(address newAddress) external {
        _onlyFactoryAdmin(msg.sender);
        _notZeroAddress(newAddress);
        address oldAddress = epochManagerImplAddress;
        epochManagerImplAddress = newAddress;
        emit EpochManagerImplChanged(oldAddress, newAddress);
    }

    function setTrancheVaultImplAddress(address newAddress) external {
        _onlyFactoryAdmin(msg.sender);
        _notZeroAddress(newAddress);
        address oldAddress = trancheVaultImplAddress;
        trancheVaultImplAddress = newAddress;
        emit TrancheVaultImplChanged(oldAddress, newAddress);
    }

    function setCreditDueManagerImplAddress(address newAddress) external {
        _onlyFactoryAdmin(msg.sender);
        _notZeroAddress(newAddress);
        address oldAddress = creditDueManagerImplAddress;
        creditDueManagerImplAddress = newAddress;
        emit CreditDueManagerImplChanged(oldAddress, newAddress);
    }

    function setReceivableImplAddress(address newAddress) external {
        _onlyFactoryAdmin(msg.sender);
        _notZeroAddress(newAddress);
        address oldAddress = receivableImpl;
        receivableImpl = newAddress;
        emit ReceivableImplChanged(oldAddress, newAddress);
    }

    /**
     * @dev If the deployer has details about the first loss covers of a pool,
     * the deployer can set them using this function after a pool is created
     */
    function setFirstLossCover(
        address poolConfigAddress,
        uint8 poolCoverIndex,
        uint16 coverRatePerLossInBps,
        uint96 coverCapPerLoss,
        uint96 maxLiquidity,
        uint96 minLiquidity,
        uint16 riskYieldMultiplierInBps,
        string memory firstLossCoverName,
        string memory firstLossCoverSymbol
    ) external {
        _onlyDeployer(msg.sender);
        _setFirstLossCover(
            PoolConfig(poolConfigAddress),
            poolCoverIndex,
            coverRatePerLossInBps,
            coverCapPerLoss,
            maxLiquidity,
            minLiquidity,
            riskYieldMultiplierInBps,
            firstLossCoverName,
            firstLossCoverSymbol
        );
    }

    /**
     * @dev The first step of deploying a pool
     * @param _poolName The name of the pool
     * @param assetTokenAddress The address of the asset token, e.g. USDC
     * @param receivableAddress The address of the receivable, can be provided by the pool owner or using Huma implementation
     * @param tranchesPolicyType The type of tranches policy, can be "fixed" or "adjusted"
     * @param creditType The type of credit, can be "receivablebacked", "receivablefactoring" or "creditline"
     * TODO: Upgrade the factory when there's more credit types or tranches policy types
     */
    function deployPool(
        string memory _poolName,
        address assetTokenAddress,
        address receivableAddress,
        string memory tranchesPolicyType,
        string memory creditType
    ) external {
        _onlyDeployer(msg.sender);
        (address poolConfigAddress, address[] memory poolAddresses) = _createPoolContracts(
            _poolName,
            assetTokenAddress,
            tranchesPolicyType,
            creditType
        );
        PoolConfig poolConfig = PoolConfig(poolConfigAddress);

        if (receivableAddress != address(0)) {
            poolConfig.setReceivableAsset(receivableAddress);
        }

        // First Loss Cover index [0, 1, 2] are reserved for borrower, insurance and admin
        // all fields are set to 0 by default, and can be changed by pool owner later
        // or by the deployer if the pool owner provides the details
        _setFirstLossCover(
            poolConfig,
            uint8(BORROWER_LOSS_COVER_INDEX),
            0,
            0,
            0,
            0,
            0,
            "Borrower First Loss Cover",
            "BFLC"
        );
        _setFirstLossCover(
            poolConfig,
            uint8(INSURANCE_LOSS_COVER_INDEX),
            0,
            0,
            0,
            0,
            0,
            "Insurance First Loss Cover",
            "IFLC"
        );
        _setFirstLossCover(
            poolConfig,
            uint8(ADMIN_LOSS_COVER_INDEX),
            0,
            0,
            0,
            0,
            0,
            "Admin First Loss Cover",
            "AFLC"
        );
        for (uint8 i = 3; i <= 12; i++) {
            // when index is 8 or 9, it is senior or junior tranche vault
            // trancheVault uses different initialize function
            if (i == 8) {
                IVaultLike(poolAddresses[i]).initialize(
                    "Senior Tranche Vault",
                    "STV",
                    poolConfig,
                    uint8(SENIOR_TRANCHE)
                );
            } else if (i == 9) {
                IVaultLike(poolAddresses[i]).initialize(
                    "Junior Tranche Vault",
                    "JTV",
                    poolConfig,
                    uint8(JUNIOR_TRANCHE)
                );
            } else {
                IPoolConfigCacheLike(poolAddresses[i]).initialize(poolConfigAddress);
            }
        }
        _registerPool(poolAddresses[3], _poolName, poolConfigAddress, address(0));
    }

    // After deploying a new pool, the deployer needs to set pool parameters using this function
    function setPoolSettings(
        uint256 _poolId,
        uint96 maxCreditLine,
        uint96 minDepositAmount,
        PayPeriodDuration payPeriodDuration,
        uint8 latePaymentGracePeriodIndays,
        uint16 defaultGracePeriodInDays,
        uint16 advanceRateInBps,
        bool receivableAutoApproval
    ) external {
        _onlyDeployer(msg.sender);
        PoolSettings memory settings = PoolSettings({
            maxCreditLine: maxCreditLine,
            minDepositAmount: minDepositAmount,
            payPeriodDuration: payPeriodDuration,
            latePaymentGracePeriodInDays: latePaymentGracePeriodIndays,
            defaultGracePeriodInDays: defaultGracePeriodInDays,
            advanceRateInBps: advanceRateInBps,
            receivableAutoApproval: receivableAutoApproval
        });
        PoolConfig(pools[_poolId].poolConfigAddress).setPoolSettings(settings);
    }

    // After deploying a new pool, the deployer needs to set pool parameters using this function
    function setLPConfig(
        uint256 _poolId,
        uint96 liquidityCap,
        uint8 maxSeniorJuniorRatio,
        uint16 fixedSeniorYieldInBps,
        uint16 tranchesRiskAdjustmentInBps,
        uint16 withdrawalLockoutPeriodInDays
    ) external {
        _onlyDeployer(msg.sender);
        LPConfig memory lpConfig = LPConfig({
            liquidityCap: liquidityCap,
            maxSeniorJuniorRatio: maxSeniorJuniorRatio,
            fixedSeniorYieldInBps: fixedSeniorYieldInBps,
            tranchesRiskAdjustmentInBps: tranchesRiskAdjustmentInBps,
            withdrawalLockoutPeriodInDays: withdrawalLockoutPeriodInDays
        });
        PoolConfig(pools[_poolId].poolConfigAddress).setLPConfig(lpConfig);
    }

    // After deploying a new pool, the deployer needs to set pool parameters using this function
    function setFees(
        uint256 _poolId,
        uint96 frontLoadingFeeFlat,
        uint16 frontLoadingFeeBps,
        uint16 yieldInBps,
        uint16 minPrincipalRateInBps,
        uint16 lateFeeBps,
        uint256 poolOwnerRewardRate,
        uint256 poolOwnerLiquidityRate,
        uint256 eaRewardRate,
        uint256 eaLiquidityRate
    ) external {
        _onlyDeployer(msg.sender);
        FrontLoadingFeesStructure memory frontLoadingFees = FrontLoadingFeesStructure({
            frontLoadingFeeFlat: frontLoadingFeeFlat,
            frontLoadingFeeBps: frontLoadingFeeBps
        });
        PoolConfig poolConfig = PoolConfig(pools[_poolId].poolConfigAddress);
        poolConfig.setFrontLoadingFees(frontLoadingFees);
        FeeStructure memory fees = FeeStructure({
            yieldInBps: yieldInBps,
            minPrincipalRateInBps: minPrincipalRateInBps,
            lateFeeBps: lateFeeBps
        });
        poolConfig.setFeeStructure(fees);
        poolConfig.setPoolOwnerRewardsAndLiquidity(poolOwnerRewardRate, poolOwnerLiquidityRate);
        poolConfig.setEARewardsAndLiquidity(eaRewardRate, eaLiquidityRate);
    }

    // After deploying a new pool, the deployer needs to set pool parameters using this function
    // if the deployer has the details of pool operators, the deployer can set them using this function
    // otherwise, the pool owner can set them later
    function addPoolOperator(uint256 _poolId, address poolOperator) external {
        _onlyDeployer(msg.sender);
        _notZeroAddress(poolOperator);
        PoolConfig poolConfig = PoolConfig(pools[_poolId].poolConfigAddress);
        poolConfig.grantRole(poolConfig.POOL_OPERATOR_ROLE(), poolOperator);
    }

    // Huma requires all pools to have a timelock controller, this function adds a timelock controller to a pool
    function addTimelock(
        uint256 _poolId,
        address[] memory poolOwners,
        address[] memory poolExecutors
    ) external {
        _onlyDeployer(msg.sender);
        address timelockAddress = LibTimelockController.addTimelockController(
            0,
            poolOwners,
            poolExecutors,
            address(0)
        );

        PoolConfig poolConfig = PoolConfig(pools[_poolId].poolConfigAddress);
        poolConfig.grantRole(poolConfig.DEFAULT_ADMIN_ROLE(), timelockAddress);
        poolConfig.renounceRole(poolConfig.DEFAULT_ADMIN_ROLE(), address(this));

        emit TimelockAddedToPool(_poolId, pools[_poolId].poolAddress, timelockAddress);
        pools[_poolId].poolTimelock = timelockAddress;
    }

    // After pool parameters are set, and timelock is added, the pool status can be updated to Initialized
    // which means the pool is ready for operation
    function updatePoolStatus(uint256 _poolId, PoolStatus newStatus) external {
        _onlyDeployer(msg.sender);
        _validPoolId(_poolId);
        emit PoolStatusUpdated(
            _poolId,
            pools[_poolId].poolAddress,
            pools[_poolId].poolName,
            pools[_poolId].poolStatus,
            newStatus
        );
        pools[_poolId].poolStatus = newStatus;
    }

    /**
     * @dev Adds a new receivable contract with the specified owner.
     * Only the deployer of the contract can call this function.
     * The `receivableOwner` parameter must be a non-zero address.
     * @custom:access The deployer is granted the DEFAULT_ADMIN_ROLE on the receivable contract,
     * @custom:access and then renounces the role, transferring ownership to `receivableOwner`.
     * Emits a `ReceivableCreated` event with the address of the newly created receivable contract.
     */
    function addReceivable(address receivableOwner) external {
        _onlyDeployer(msg.sender);
        _notZeroAddress(receivableOwner);
        address receivable = _addProxy(receivableImpl, abi.encodeWithSignature("initialize()"));
        AccessControlUpgradeable receivableContract = AccessControlUpgradeable(receivable);
        receivableContract.grantRole(receivableContract.DEFAULT_ADMIN_ROLE(), receivableOwner);
        receivableContract.renounceRole(receivableContract.DEFAULT_ADMIN_ROLE(), address(this));
        emit ReceivableCreated(receivable);
    }

    // Returns the corresponding poolRecord for a poolId
    function checkPool(uint256 _poolId) external view returns (PoolRecord memory) {
        _validPoolId(_poolId);
        return pools[_poolId];
    }

    function _validPoolId(uint256 _poolId) internal view {
        if (_poolId == 0 || _poolId > poolId) {
            revert Errors.InvalidPoolId();
        }
    }

    function _onlyFactoryAdmin(address account) internal view {
        if (!hasRole(DEFAULT_ADMIN_ROLE, account)) {
            revert Errors.AdminRequired();
        }
    }

    function _onlyDeployer(address account) internal view {
        if (!hasRole(DEPLOYER_ROLE, account)) {
            revert Errors.DeployerRequired();
        }
    }

    // Only DEFAULT_ADMIN_ROLE can upgrade the implementation addresses
    function _authorizeUpgrade(address) internal view override {
        _onlyFactoryAdmin(msg.sender);
    }

    function _notZeroAddress(address newAddress) internal pure {
        if (newAddress == address(0)) revert Errors.ZeroAddressProvided();
    }

    // adds a pool in PoolRecord
    function _registerPool(
        address _poolAddress,
        string memory _poolName,
        address _poolConfigAddress,
        address _poolTimelockAddress
    ) private {
        poolId = poolId + 1;
        pools[poolId] = PoolRecord(
            poolId,
            _poolAddress,
            _poolName,
            PoolStatus.Created,
            _poolConfigAddress,
            _poolTimelockAddress
        );
        emit PoolAdded(poolId, _poolAddress, _poolName);
    }

    function _setFirstLossCover(
        PoolConfig poolConfig,
        uint8 poolCoverIndex,
        uint16 coverRatePerLossInBps,
        uint96 coverCapPerLoss,
        uint96 maxLiquidity,
        uint96 minLiquidity,
        uint16 riskYieldMultiplierInBps,
        string memory firstLossCoverName,
        string memory firstLossCoverSymbol
    ) private {
        _notZeroAddress(address(poolConfig));
        address firstLossCover = _addProxy(
            firstLossCoverImplAddress,
            abi.encodeWithSignature(
                "initialize(string,string,address)",
                firstLossCoverName,
                firstLossCoverSymbol,
                poolConfig
            )
        );
        FirstLossCoverConfig memory config = FirstLossCoverConfig(
            coverRatePerLossInBps,
            coverCapPerLoss,
            maxLiquidity,
            minLiquidity,
            riskYieldMultiplierInBps
        );
        poolConfig.setFirstLossCover(poolCoverIndex, firstLossCover, config);
    }

    // add a proxy
    function _addProxy(address _implAddress, bytes memory _calldata) private returns (address) {
        _notZeroAddress(_implAddress);
        ERC1967Proxy proxy = new ERC1967Proxy(_implAddress, _calldata);
        return address(proxy);
    }

    /**
     * @dev Creates a set of pool contracts for a given pool name, asset token address, tranches policy type, and credit type.
     * @param _poolName The name of the pool.
     * @param assetTokenAddress The address of the asset token.
     * @param tranchesPolicyType The type of tranches policy.
     * @param creditType The type of credit.
     * @return poolConfigAddress The address of the pool configuration contract.
     * @return poolAddresses An array of addresses representing the pool contracts.
     * The array index corresponds to the initialize function in PoolConfig.sol
     */
    function _createPoolContracts(
        string memory _poolName,
        address assetTokenAddress,
        string memory tranchesPolicyType,
        string memory creditType
    ) private returns (address, address[] memory) {
        address[] memory poolAddresses = new address[](13); // 13 is the number of contracts in a pool
        poolAddresses[0] = humaConfigAddress;
        poolAddresses[1] = assetTokenAddress;
        poolAddresses[2] = calendarAddress;
        poolAddresses[3] = _addProxy(poolImplAddress, ""); // poolConfig
        poolAddresses[4] = _addProxy(poolSafeImplAddress, ""); // poolSafe
        poolAddresses[5] = _addProxy(poolFeeManagerImplAddress, ""); // poolFeeManager

        if (keccak256(bytes(tranchesPolicyType)) == keccak256(bytes("fixed"))) {
            poolAddresses[6] = _addProxy(fixedSeniorYieldTranchesPolicyImplAddress, "");
        } else if (keccak256(bytes(tranchesPolicyType)) == keccak256(bytes("adjusted"))) {
            poolAddresses[6] = _addProxy(riskAdjustedTranchesPolicyImplAddress, "");
        } else {
            revert Errors.InvalidTranchesPolicyType();
        }

        poolAddresses[7] = _addProxy(epochManagerImplAddress, ""); // epochManager
        poolAddresses[8] = _addProxy(trancheVaultImplAddress, ""); // senior tranche vault
        poolAddresses[9] = _addProxy(trancheVaultImplAddress, ""); // junior tranche vault
        poolAddresses[11] = _addProxy(creditDueManagerImplAddress, ""); // creditDueManager

        if (keccak256(bytes(creditType)) == keccak256(bytes("receivablebacked"))) {
            poolAddresses[10] = _addProxy(receivableBackedCreditLineImplAddress, "");
            poolAddresses[12] = _addProxy(receivableBackedCreditLineManagerImplAddress, "");
        } else if (keccak256(bytes(creditType)) == keccak256(bytes("receivablefactoring"))) {
            poolAddresses[10] = _addProxy(receivableFactoringCreditImplAddress, "");
            poolAddresses[12] = _addProxy(receivableFactoringCreditManagerImplAddress, "");
        } else if (keccak256(bytes(creditType)) == keccak256(bytes("creditline"))) {
            poolAddresses[10] = _addProxy(creditLineImplAddress, "");
            poolAddresses[12] = _addProxy(creditLineManagerImplAddress, "");
        } else {
            revert Errors.InvalidCreditType();
        }
        address poolConfigAddress = _addProxy(
            poolConfigImplAddress,
            abi.encodeWithSignature("initialize(string,address[])", _poolName, poolAddresses)
        );

        emit PoolCreated(poolAddresses[3], _poolName);
        return (poolConfigAddress, poolAddresses);
    }
}
