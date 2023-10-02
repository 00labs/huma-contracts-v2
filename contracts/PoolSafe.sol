// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {Errors} from "./Errors.sol";
import {PoolConfig} from "./PoolConfig.sol";
import {PoolConfigCache} from "./PoolConfigCache.sol";
import {IFirstLossCover} from "./interfaces/IFirstLossCover.sol";
import {IPoolFeeManager} from "./interfaces/IPoolFeeManager.sol";
import {IPoolSafe} from "./interfaces/IPoolSafe.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title PoolSafe
 * @notice PoolSafe tracks the in flow and out flow of underlying tokens
 */
contract PoolSafe is PoolConfigCache, IPoolSafe {
    IERC20 public underlyingToken;
    IFirstLossCover[] internal _firstLossCovers;
    IPoolFeeManager public poolFeeManager;

    uint96 public reservedForRedemption;

    function _updatePoolConfigData(PoolConfig _poolConfig) internal virtual override {
        address addr = _poolConfig.underlyingToken();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        underlyingToken = IERC20(addr);

        addr = _poolConfig.poolFeeManager();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        poolFeeManager = IPoolFeeManager(addr);

        address[16] memory covers = _poolConfig.getFirstLossCovers();
        for (uint256 i = 0; i < covers.length; i++) {
            if (covers[i] != address(0)) _firstLossCovers.push(IFirstLossCover(covers[i]));
            else break;
        }
    }

    /// @inheritdoc IPoolSafe
    function deposit(address from, uint256 amount) external virtual {
        poolConfig.onlyTrancheVaultOrFirstLossCoverOrCreditOrPoolFeeManager(msg.sender);

        underlyingToken.transferFrom(from, address(this), amount);
    }

    /// @inheritdoc IPoolSafe
    function withdraw(address to, uint256 amount) external virtual {
        if (to == address(0)) revert Errors.zeroAddressProvided();
        poolConfig.onlyTrancheVaultOrFirstLossCoverOrCreditOrPoolFeeManager(msg.sender);

        underlyingToken.transfer(to, amount);
    }

    //: todo Need to evaluate this API more carefully. An alternative approach
    // is to increase or decrease redemption reserve.
    function setRedemptionReserve(uint256 reserve) external virtual {
        poolConfig.onlyPool(msg.sender);

        reservedForRedemption = uint96(reserve);
    }

    /// @inheritdoc IPoolSafe
    function getAvailableLiquidity() external view virtual returns (uint256 assets) {
        assets = totalAssets();
        uint96 tempReservedForRedemption = reservedForRedemption;
        assets = assets > tempReservedForRedemption ? assets - tempReservedForRedemption : 0;
    }

    /**
     * @notice Gets pool assets that can be used for redemption. It should be the lower of
     * the sum of redemption requests and available liquidity in the pool.
     */
    function getAvailableReservation() external view virtual returns (uint256 assets) {
        //* todo This does not look right. It used the totalAsset. The assets may not be available.
        assets = totalAssets();
        uint96 tempReservedForRedemption = reservedForRedemption;
        assets = assets < tempReservedForRedemption ? assets : tempReservedForRedemption;
    }

    /// @inheritdoc IPoolSafe
    function getPoolAssets() external view virtual returns (uint256 assets) {
        return totalAssets();
    }

    /// @inheritdoc IPoolSafe
    function totalAssets() public view virtual returns (uint256 assets) {
        uint256 reserved;
        //* todo let us discuss an alternative design that puts first loss assets outside the pool
        uint256 len = _firstLossCovers.length;
        for (uint256 i = 0; i < len; i++) {
            reserved += _firstLossCovers[i].totalAssets();
        }
        reserved += poolFeeManager.getTotalAvailableFees();
        uint256 balance = underlyingToken.balanceOf(address(this));
        return balance > reserved ? balance - reserved : 0;
    }

    function getFirstLossCovers() external view virtual returns (IFirstLossCover[] memory) {
        return _firstLossCovers;
    }
}
