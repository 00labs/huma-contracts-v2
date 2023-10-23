// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {Errors} from "./Errors.sol";
import {PoolConfig} from "./PoolConfig.sol";
import {PoolConfigCache} from "./PoolConfigCache.sol";
import {IPoolFeeManager} from "./interfaces/IPoolFeeManager.sol";
import {IPoolSafe} from "./interfaces/IPoolSafe.sol";
import {IPool} from "./interfaces/IPool.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title PoolSafe
 * @notice PoolSafe tracks the in flow and out flow of underlying tokens
 */
contract PoolSafe is PoolConfigCache, IPoolSafe {
    IERC20 public underlyingToken;
    IPool public pool;
    IPoolFeeManager public poolFeeManager;

    function _updatePoolConfigData(PoolConfig _poolConfig) internal virtual override {
        address addr = _poolConfig.underlyingToken();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        underlyingToken = IERC20(addr);

        addr = _poolConfig.poolFeeManager();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        poolFeeManager = IPoolFeeManager(addr);

        addr = _poolConfig.pool();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        pool = IPool(addr);
    }

    /// @inheritdoc IPoolSafe
    function deposit(address from, uint256 amount) external virtual {
        poolConfig.onlyTrancheVaultOrFirstLossCoverOrCreditOrPoolFeeManagerOrProfitEscrow(
            msg.sender
        );

        underlyingToken.transferFrom(from, address(this), amount);
    }

    /// @inheritdoc IPoolSafe
    function withdraw(address to, uint256 amount) external virtual {
        if (to == address(0)) revert Errors.zeroAddressProvided();
        poolConfig.onlyTrancheVaultOrFirstLossCoverOrCreditOrPoolFeeManagerOrProfitEscrow(
            msg.sender
        );

        underlyingToken.transfer(to, amount);
    }

    /// @inheritdoc IPoolSafe
    function getPoolLiquidity() external view virtual returns (uint256 liquidity) {
        uint256 reserved = pool.getReservedAssetsForFirstLossCovers();
        reserved += poolFeeManager.getTotalAvailableFees();
        uint256 balance = underlyingToken.balanceOf(address(this));
        liquidity = balance > reserved ? balance - reserved : 0;
    }

    /// @inheritdoc IPoolSafe
    function totalLiquidity() external view returns (uint256 liquidity) {
        liquidity = underlyingToken.balanceOf(address(this));
    }

    /// @inheritdoc IPoolSafe
    function getAvailableLiquidityForFees() external view returns (uint256 liquidity) {
        uint256 balance = underlyingToken.balanceOf(address(this));
        uint256 reserved = pool.getReservedAssetsForFirstLossCovers();
        liquidity = balance > reserved ? balance - reserved : 0;
    }
}
