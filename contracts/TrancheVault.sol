// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "./SharedDefs.sol";
import {IERC20MetadataUpgradeable, ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {TrancheVaultStorage, IERC20} from "./TrancheVaultStorage.sol";
import {IEpoch, EpochInfo} from "./interfaces/IEpoch.sol";
import {IEpochManager} from "./interfaces/IEpochManager.sol";
import {Errors} from "./Errors.sol";
import {PoolConfig, LPConfig} from "./PoolConfig.sol";
import {PoolConfigCacheUpgradeable} from "./PoolConfigCacheUpgradeable.sol";
import {IPool} from "./interfaces/IPool.sol";
import {IPoolVault} from "./interfaces/IPoolVault.sol";

contract TrancheVault is
    AccessControlUpgradeable,
    ERC20Upgradeable,
    PoolConfigCacheUpgradeable,
    TrancheVaultStorage,
    IEpoch
{
    bytes32 public constant LENDER_ROLE = keccak256("LENDER");

    event LiquidityDeposited(address indexed account, uint256 assetAmount, uint256 shareAmount);

    event RedemptionRequestAdded(address indexed account, uint256 shareAmount, uint256 epochId);
    event RedemptionRequestRemoved(address indexed account, uint256 shareAmount, uint256 epochId);

    event EpochsProcessed(
        uint256 epochCount,
        uint256 sharesProcessed,
        uint256 amountProcessed,
        uint256 unprocessedIndexOfEpochIds
    );

    event UserDisbursed(address indexed account, address receiver, uint256 withdrawnAmount);

    constructor() {
        // _disableInitializers();
    }

    function initialize(
        string memory name,
        string memory symbol,
        PoolConfig _poolConfig,
        uint8 seniorTrancheOrJuniorTranche
    ) external initializer {
        __ERC20_init(name, symbol);
        __AccessControl_init();

        poolConfig = _poolConfig;

        if (seniorTrancheOrJuniorTranche > 1) revert Errors.invalidTrancheIndex();
        trancheIndex = seniorTrancheOrJuniorTranche;

        _updatePoolConfigData(_poolConfig);
    }

    function _updatePoolConfigData(PoolConfig _poolConfig) internal virtual override {
        address addr = _poolConfig.underlyingToken();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        underlyingToken = IERC20(addr);
        _decimals = IERC20MetadataUpgradeable(addr).decimals();

        addr = _poolConfig.pool();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        pool = IPool(addr);

        addr = _poolConfig.poolVault();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        poolVault = IPoolVault(addr);

        addr = _poolConfig.epochManager();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        epochManager = IEpochManager(addr);
    }

    /**
     * @notice Lenders need to pass compliance requirements. Pool operator will administer off-chain
     * to make sure potential lenders meet the requirements. Afterwords, the pool operator will
     * call this function to mark a lender as approved.
     */
    function addApprovedLender(address lender) external {
        poolConfig.onlyPoolOperator(msg.sender);
        if (lender == address(0)) revert Errors.zeroAddressProvided();
        _grantRole(LENDER_ROLE, lender);
    }

    /**
     * @notice Disables a lender. This prevents the lender from making more deposits.
     * The capital that the lender has contributed can continue to work as normal.
     */
    function removeApprovedLender(address lender) external {
        poolConfig.onlyPoolOperator(msg.sender);
        if (lender == address(0)) revert Errors.zeroAddressProvided();
        _revokeRole(LENDER_ROLE, lender);
    }

    /**
     * @notice Returns all unprocessed epochs.
     */
    function unprocessedEpochInfos() external view override returns (EpochInfo[] memory result) {
        uint256 len = epochIds.length - unprocessedIndexOfEpochIds;
        result = new EpochInfo[](len);
        for (uint256 i; i < len; i++) {
            result[i] = epochMap[epochIds[unprocessedIndexOfEpochIds + i]];
        }
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function totalSupply() public view override returns (uint256) {
        return ERC20Upgradeable.totalSupply();
    }

    /**
     * @notice Updates processed epochs
     */
    function processEpochs(
        EpochInfo[] memory epochsProcessed,
        uint256 sharesProcessed,
        uint256 amountProcessed
    ) external {
        poolConfig.onlyEpochManager(msg.sender);

        uint256 count = epochsProcessed.length;
        EpochInfo memory epoch;
        for (uint256 i; i < count; i++) {
            epoch = epochsProcessed[i];
            epochMap[epoch.epochId] = epoch;
        }

        // Check if the last epoch is fully processed
        uint256 unprocessedIndex = unprocessedIndexOfEpochIds;
        if (epoch.totalAmountProcessed >= epoch.totalShareRequested) {
            unprocessedIndex += count;
        } else if (count - 1 > 0) {
            unprocessedIndex += count - 1;
        }
        unprocessedIndexOfEpochIds = unprocessedIndex;

        // Burn processed shares
        ERC20Upgradeable._burn(address(this), sharesProcessed);

        // Withdraw underlying tokens from reserve
        poolVault.withdraw(address(this), amountProcessed);

        emit EpochsProcessed(count, sharesProcessed, amountProcessed, unprocessedIndex);
    }

    /**
     * @notice LP deposits to the pool to earn interest, and share losses
     *
     * @notice All deposits should be made by calling this function and
     * makeInitialDeposit() (for pool owner and EA's initial deposit) only.
     * Please do NOT directly transfer any digital assets to the contracts,
     * which will cause a permanent loss and we cannot help reverse transactions
     * or retrieve assets from the contracts.
     *
     * @param assets the number of underlyingToken to be deposited
     * @param receiver the address to receive the minted tranche token
     * @return shares the number of tranche token to be minted
     */
    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        if (assets == 0) revert Errors.zeroAmountProvided();
        if (receiver == address(0)) revert Errors.zeroAddressProvided();
        _onlyLender(msg.sender);
        _onlyLender(receiver);
        poolConfig.onlyProtocolAndPoolOn();
        return _deposit(assets, receiver);
    }

    function _deposit(uint256 assets, address receiver) internal returns (uint256 shares) {
        uint256 cap = poolConfig.getTrancheLiquidityCap(trancheIndex);
        if (assets > cap) {
            revert Errors.exceededPoolLiquidityCap();
        }
        uint96[2] memory tranches = pool.refreshPool();
        uint256 ta = tranches[trancheIndex];
        if (ta + assets > cap) {
            revert Errors.exceededPoolLiquidityCap();
        }

        if (trancheIndex == SENIOR_TRANCHE_INDEX) {
            // validate maxRatio for senior tranche
            LPConfig memory lpConfig = poolConfig.getLPConfig();
            if ((ta + assets) > tranches[JUNIOR_TRANCHE_INDEX] * lpConfig.maxSeniorJuniorRatio)
                revert Errors.exceededMaxJuniorSeniorRatio(); // greater than max ratio
        }

        poolVault.deposit(msg.sender, assets);

        shares = _convertToShares(assets, ta);
        ERC20Upgradeable._mint(receiver, shares);

        tranches[trancheIndex] += uint96(assets);
        pool.updateTranchesAssets(tranches);

        emit LiquidityDeposited(receiver, assets, shares);
    }

    /**
     * @notice Adds Redemption assets(underlying token amount) in current Redemption request
     */
    function addRedemptionRequest(uint256 shares) external {
        if (shares == 0) revert Errors.zeroAmountProvided();
        poolConfig.onlyProtocolAndPoolOn();

        uint256 userShares = ERC20Upgradeable.balanceOf(msg.sender);
        if (shares > userShares) {
            revert Errors.withdrawnAmountHigherThanBalance(); // assets is too big
        }

        // update global epochId array and EpochInfo mapping
        uint256 currentEpochId = epochManager.currentEpochId();
        EpochInfo memory currentEpochInfo = epochMap[currentEpochId];
        if (currentEpochInfo.totalShareRequested > 0) {
            currentEpochInfo.totalShareRequested += uint96(shares);
        } else {
            epochIds.push(currentEpochId);
            currentEpochInfo.epochId = uint64(currentEpochId);
            currentEpochInfo.totalShareRequested = uint96(shares);
        }
        epochMap[currentEpochId] = currentEpochInfo;

        // update user UserRedemptionRequest array
        UserRedemptionRequest[] storage requests = userRedemptionRequests[msg.sender];
        uint256 length = requests.length;
        UserRedemptionRequest memory request;
        if (length > 0) {
            request = requests[length - 1];
        }
        if (request.epochId == currentEpochId) {
            // add assets in current Redemption request
            request.shareRequested += uint96(shares);
            requests[length - 1] = request;
        } else {
            // no Redemption request, create a new one
            request.epochId = uint64(currentEpochId);
            request.shareRequested = uint96(shares);
            requests.push(request);
        }

        ERC20Upgradeable._transfer(msg.sender, address(this), shares);

        emit RedemptionRequestAdded(msg.sender, shares, currentEpochId);
    }

    /**
     * @notice Removes Redemption assets(underlying token amount) from current Redemption request
     */
    function removeRedemptionRequest(uint256 shares) external {
        if (shares == 0) revert Errors.zeroAmountProvided();
        poolConfig.onlyProtocolAndPoolOn();

        UserRedemptionRequest[] storage requests = userRedemptionRequests[msg.sender];
        uint256 length = requests.length;
        if (length == 0) revert Errors.emptyArray();
        uint256 lastIndex = length - 1;
        UserRedemptionRequest memory request = requests[lastIndex];
        uint256 currentEpochId = epochManager.currentEpochId();
        if (request.epochId < currentEpochId) {
            // only remove from current Redemption request
            revert Errors.notCurrentEpoch();
        }
        if (request.shareRequested < shares) {
            revert Errors.shareHigherThanRequested();
        }

        request.shareRequested -= uint96(shares);
        if (request.shareRequested > 0) {
            requests[lastIndex] = request;
        } else {
            delete requests[lastIndex];
        }

        EpochInfo memory currentEpochInfo = epochMap[currentEpochId];
        currentEpochInfo.totalShareRequested -= uint96(shares);
        if (currentEpochInfo.totalShareRequested > 0) {
            epochMap[currentEpochId] = currentEpochInfo;
        } else {
            delete epochMap[currentEpochId];
            lastIndex = epochIds.length - 1;
            assert(epochIds[lastIndex] == currentEpochId);
            delete epochIds[lastIndex];
        }

        ERC20Upgradeable._transfer(address(this), msg.sender, shares);

        emit RedemptionRequestRemoved(msg.sender, shares, currentEpochId);
    }

    /**
     * @notice Transfers processed underlying tokens to the user
     */
    function disburse(address receiver) external {
        poolConfig.onlyProtocolAndPoolOn();

        (uint256 withdrableAmount, UserDisburseInfo memory disburseInfo) = _getUserWithdrawable(
            msg.sender
        );
        userDisburseInfos[msg.sender] = disburseInfo;

        underlyingToken.transfer(receiver, withdrableAmount);

        emit UserDisbursed(msg.sender, receiver, withdrableAmount);
    }

    /**
     * @notice Returns the withdrawable assets value of the given account
     */
    function withdrawableAssets(address account) external view returns (uint256 assets) {
        (assets, ) = _getUserWithdrawable(account);
    }

    function removableRedemptionShares(address account) external view returns (uint256 shares) {
        UserRedemptionRequest[] storage requests = userRedemptionRequests[account];
        uint256 length = requests.length;
        if (length > 0) {
            uint256 lastIndex = requests.length - 1;
            UserRedemptionRequest memory request = requests[lastIndex];
            uint256 epochId = epochManager.currentEpochId();
            if (request.epochId == epochId) {
                UserDisburseInfo memory disburseInfo = userDisburseInfos[account];
                if (
                    disburseInfo.requestsIndex == lastIndex &&
                    disburseInfo.partialShareProcessed > 0
                ) {
                    // shares = 0;
                } else {
                    shares = request.shareRequested;
                }
            }
        }
    }

    function totalAssets() public view returns (uint256) {
        return pool.trancheTotalAssets(trancheIndex);
    }

    function convertToShares(uint256 assets) external view returns (uint256 shares) {
        shares = _convertToShares(assets, totalAssets());
    }

    function getRedemptionEpochLength() external view returns (uint256) {
        return epochIds.length;
    }

    function getUserRedemptionRequestLength(address account) external view returns (uint256) {
        return userRedemptionRequests[account].length;
    }

    function _convertToShares(
        uint256 _assets,
        uint256 _totalAssets
    ) internal view returns (uint256 shares) {
        // TODO solve the first tiny deposit vector - https://github.com/spearbit/portfolio/blob/master/pdfs/MapleV2.pdf

        uint256 supply = ERC20Upgradeable.totalSupply();

        return supply == 0 ? _assets : (_assets * supply) / _totalAssets;
    }

    function _updateUserWithdrawable(address user) internal returns (uint256 withdrableAmount) {}

    /**
     * @notice Calculates withdrawable amount from the last index of user Redemption request array
     * to current processed user Redemption request
     */
    function _getUserWithdrawable(
        address user
    ) internal view returns (uint256 withdrableAmount, UserDisburseInfo memory disburseInfo) {
        disburseInfo = userDisburseInfos[user];
        UserRedemptionRequest[] storage requests = userRedemptionRequests[user];
        uint256 len = epochIds.length;
        uint256 epochIdsIndex = unprocessedIndexOfEpochIds;
        uint256 lastEpochId = epochIdsIndex < len
            ? epochIds[epochIdsIndex]
            : epochIds[len - 1] + 1;

        for (uint256 i = disburseInfo.requestsIndex; i < requests.length; i++) {
            UserRedemptionRequest memory request = requests[i];
            if (request.epochId < lastEpochId) {
                // Fully processed
                EpochInfo memory epoch = epochMap[request.epochId];
                // TODO There will be one decimal unit of rounding error here if it can't be divisible.
                uint256 shareProcessed = (request.shareRequested * epoch.totalShareProcessed) /
                    epoch.totalShareRequested;
                uint256 amountProcessed = (request.shareRequested * epoch.totalAmountProcessed) /
                    epoch.totalShareRequested;
                if (disburseInfo.partialShareProcessed > 0) {
                    shareProcessed -= disburseInfo.partialShareProcessed;
                    amountProcessed -= disburseInfo.partialAmountProcessed;
                    disburseInfo.partialShareProcessed = 0;
                    disburseInfo.partialAmountProcessed = 0;
                }

                withdrableAmount += shareProcessed;
                disburseInfo.requestsIndex += 1;
            } else if (request.epochId == lastEpochId) {
                // partially processed
                EpochInfo memory epoch = epochMap[request.epochId];
                if (epoch.totalShareProcessed > 0) {
                    uint256 shareProcessed = (request.shareRequested * epoch.totalShareProcessed) /
                        epoch.totalShareRequested;
                    uint256 amountProcessed = (request.shareRequested *
                        epoch.totalAmountProcessed) / epoch.totalShareRequested;
                    withdrableAmount += amountProcessed - disburseInfo.partialAmountProcessed;
                    disburseInfo.partialShareProcessed = uint96(shareProcessed);
                    disburseInfo.partialAmountProcessed = uint96(amountProcessed);
                }
                break;
            }
        }
    }

    function _onlyLender(address account) internal view {
        if (!hasRole(LENDER_ROLE, account)) revert Errors.permissionDeniedNotLender();
    }
}
