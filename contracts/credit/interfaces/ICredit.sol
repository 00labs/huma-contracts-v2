// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;
import {CreditRecord, DueDetail, CreditLoss} from "../CreditStructs.sol";

interface ICredit {
    function getCreditRecord(bytes32 creditHash) external view returns (CreditRecord memory);

    function getDueDetail(bytes32 creditHash) external view returns (DueDetail memory);

    function getCreditLoss(bytes32 creditHash) external view returns (CreditLoss memory);

    function setCreditRecord(bytes32 creditHash, CreditRecord memory cr) external;

    function setDueDetail(bytes32 creditHash, DueDetail memory dd) external;

    function setCreditLoss(bytes32 creditHash, CreditLoss memory loss) external;

    function updateDueInfo(
        bytes32 creditHash,
        uint256 timestamp
    ) external returns (CreditRecord memory cr, DueDetail memory dd);
}
